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

const SUFFIX_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function randomSuffix(length = 5) {
    let result = ''
    for (let i = 0; i < length; i++) {
        result += SUFFIX_CHARS[Math.floor(Math.random() * SUFFIX_CHARS.length)]
    }
    return result
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('chat')
        .setDescription('Join a Realm, send a chat message, then disconnect')
        .setIntegrationTypes([ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall])
        .setContexts([InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel])
        .addStringOption((option) => option
            .setName('destination')
            .setDescription('Realm code or realm id')
            .setRequired(true))
        .addStringOption((option) => option
            .setName('message')
            .setDescription('The message to send')
            .setRequired(true)
            .setMaxLength(240))
        .addIntegerOption((option) => option
            .setName('time')
            .setDescription('How long to keep sending the message, in seconds (1-180)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(180)),

    async execute(interaction) {
        await interaction.deferReply()

        const destination = interaction.options.getString('destination').trim()
        const message = interaction.options.getString('message').trim()
        const time = interaction.options.getInteger('time')

        const isId = isValidRealmId(destination)
        const isCode = isValidRealmCode(destination)

        if (isId && await blockIfWhitelisted(interaction, destination)) return

        if (!isId && !isCode) {
            await interaction.editReply({ components: [errorContainer('Invalid Realm information', 'The value you provided is not a valid Realm code or Realm ID.')], flags: ComponentsV2Flags })
            return
        }

        if (!message) {
            await interaction.editReply({ components: [errorContainer('Invalid message', 'The message cannot be empty.')], flags: ComponentsV2Flags })
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

            const rawConnection = await realmApi.getConnectionInfo(realm.id)
            const connection = normalizeConnection(rawConnection)
            const deviceProfile = account.getDeviceProfile()
            const gamertag = await account.fetchGamertag().catch(() => undefined)

            const client = await connectToRealm(interaction.user.id, realmId, account.authflow, connection, deviceProfile)

            client.username = gamertag ?? ''
            client.profile = { xuid: account.xuid }

            const intervalMs = 25
            const iterations = Math.ceil((time * 1000) / intervalMs)
            const endAt = Math.floor((Date.now() + time * 1000) / 1000)

            await interaction.editReply({ components: [infoContainer('Sending', `Connected to **${realm.name}**. Sending now, ends <t:${endAt}:R>.`)], flags: ComponentsV2Flags })

            for (let i = 0; i < iterations; i++) {
                for (let b = 0; b < 50; b++) {
                    const command = `me ${message} | ${randomSuffix()}`
                    client.sendCommand(command, 'automationplayer', undefined, false)
                }
                if (i < iterations - 1) await sleep(intervalMs)
            }

            disconnectFromRealm(interaction.user.id, realmId, 'Message sent')

            await interaction.editReply({ components: [successContainer('Message sent', `Sent your message to **${realm.name}** for ${time} second(s) and disconnected.`)], flags: ComponentsV2Flags })
        } catch (error) {
            logger.error(`[/chat] Failed for ${interaction.user.id}: ${error.message}`)

            if (realmId) disconnectFromRealm(interaction.user.id, realmId, 'Chat failed')

            const timedOut = /timed out/i.test(error.message)
            const title = timedOut ? 'Connection timed out' : 'Failed to send message'
            const reasonText = error.message && error.message.trim().length > 0
                ? error.message
                : 'The Realm closed the connection and did not give a reason.'

            await interaction.editReply({ components: [errorContainer(title, reasonText)], flags: ComponentsV2Flags })
        }
    }
}
