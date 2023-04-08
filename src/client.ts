/* eslint-disable @typescript-eslint/ban-ts-comment */
import { Client, ClientOptions, Collection, Message } from 'discord.js'
import Utils, { ErrorMessageType } from './utils.js'
import logger from './logger.js'
import { connectDb, getConfig } from './db.js'
import Queue from './modules/queue.js'
import ShoukakuManager from './modules/shoukakuManager.js'
import { deletePreviousTrackStartMessage } from './helpers/playerStartHelper.js'
import { CommandInteractionManager } from './interactions/commandInteractions.js'
import { ButtonInteractionManager } from './interactions/buttonInteractions.js'

export interface CaptchaInfo {
  type: 'play' | 'search'
  query: string
  count?: number | null
  offset?: number | null
  url: string
  sid: string
  index: number
  captcha_key?: string
}

export interface PlayerTrackErrorTracker {
  count: number
  timer: NodeJS.Timeout
}

export class VkMusicBotClient extends Client {
  private exiting = false

  public captcha = new Collection<string, CaptchaInfo>()
  public timers = new Collection<string, NodeJS.Timeout>()
  public latestMenus = new Collection<string, Message>()
  public playerTrackErrorTrackers: Collection<string, PlayerTrackErrorTracker> = new Collection()

  public queue: Queue
  public shoukaku: ShoukakuManager

  public commandInteractionManager: CommandInteractionManager
  public buttonInteractionManager: ButtonInteractionManager
  // public selectMenuInteractionManager: SelectMenuInter

  constructor(options: ClientOptions) {
    if (!process.env.MONGO_URL || !process.env.REDIS_URL) throw new Error('Env not set')
    super(options)

    this.queue = new Queue(this)
    this.shoukaku = new ShoukakuManager(this)
    this.commandInteractionManager = new CommandInteractionManager(this)
    this.buttonInteractionManager = new ButtonInteractionManager(this)

    this.once('ready', async () => {
      //this.manager.init(this.user?.id)
      //await this.initDb()
      // const slashCommandManager = new SlashCommandManager(this)
      // await slashCommandManager.init()
      logger.info(`Logged in as ${this.user?.tag} successfully`)

      await this.commandInteractionManager.load()
      await this.buttonInteractionManager.load()

      logger.info(`Loaded ${this.commandInteractionManager.interactions.size} commands.`)
      logger.info(`Loaded ${this.buttonInteractionManager.interactions.size} button interactions.`)
    })
      // .on('guildDelete', (guild) => {
      //   logger.info({ guild_id: guild.id }, 'Bot leaves')
      //   this.queue.get(guild.id)?.destroy()

      //   Utils.clearExitTimeout(guild.id, this)
      // })
      .on('messageDelete', (message) => {
        if (!message.inGuild()) return

        const menuMessage = this.latestMenus.get(message.guildId)
        if (!menuMessage) return

        if (message.id === menuMessage.id) {
          this.latestMenus.delete(message.guildId)
          logger.info('removed latestMenusMessage')
        }
      })

      // TODO: fix this shit
      .on('voiceStateUpdate', async (oldState, newState) => {
        logger.info({
          newState: newState,
          oldState: oldState
        })

        if (oldState.id === this.user?.id) {
          const newChannelId = newState.channelId
          const oldChannelId = oldState.channelId
          const guildId = newState.guild.id

          const player = this.queue.get(guildId)
          if (!player) return

          const config = await getConfig(guildId)

          let state: 'UNKNOWN' | 'LEFT' | 'JOINED' | 'MOVED' = 'UNKNOWN'
          if (!oldChannelId && newChannelId) state = 'JOINED'
          else if (oldChannelId && !newChannelId) state = 'LEFT'
          else if (oldChannelId && newChannelId && oldChannelId !== newChannelId) state = 'MOVED'

          if (state === 'UNKNOWN') return

          if (state === 'LEFT') {
            await player.safeDestroy()
            logger.debug({ guildId }, 'Player left')
            return
          }

          if (state === 'MOVED' && !config.enable247) {
            const members = newState.channel?.members.filter((m) => !m.user.bot)

            if (members?.size === 0) {
              const textId = player.textChannelId

              await Promise.all([deletePreviousTrackStartMessage(this, guildId), player.safeDestroy()])

              const channel = this.channels.cache.get(textId)
              if (!channel?.isTextBased()) return

              await Utils.sendMessageToChannel(
                channel,
                {
                  embeds: [
                    Utils.generateErrorMessage(
                      'Я вышел из канала, так как тут никого нет. ' +
                        'Включите режим 24/7 (/247), если не хотите, чтобы это происходило.',
                      ErrorMessageType.Info
                    )
                  ]
                },
                20000
              )

              logger.debug({ guildId }, 'Player moved')
            }
          }
        } else {
          const voiceChannel = oldState.channel || newState.channel
          if (!voiceChannel) return

          const config = await getConfig(voiceChannel.guildId)
          if (config.enable247) return

          const player = this.queue.get(voiceChannel.guildId)
          if (!player) return

          const members = voiceChannel.members.filter((m) => !m.user.bot)

          if (members.size === 0) {
            const textId = player.textChannelId

            await Promise.all([deletePreviousTrackStartMessage(this, voiceChannel.guildId), player.safeDestroy()])

            const channel = this.channels.cache.get(textId)
            if (!channel?.isTextBased()) return

            await Utils.sendMessageToChannel(
              channel,
              {
                embeds: [
                  Utils.generateErrorMessage(
                    'Я вышел из канала, так как тут никого нет. ' +
                      'Включите режим 24/7 (/247), если не хотите, чтобы это происходило.',
                    ErrorMessageType.Info
                  )
                ]
              },
              30_000
            )

            logger.debug({ guildId: voiceChannel.guildId }, 'Player leaved empty channel')
          }
        }
      })
  }

  async login(token?: string | undefined) {
    await super.login(token)

    // setTimeout(() => {
    //   new Promise((resolve, reject) => {
    //     reject()
    //   })
    // }, 5000)

    await connectDb()
    logger.info('DB connected.')

    // @ts-ignore
    // const shardClientUtil = this.shard as ShardClientUtil
    // shardClientUtil.on('message', (msg: any) => {
    //   if (msg?.content?.op === 'serverCount' && msg?.repliable) msg.reply(this.guilds.cache.size)
    //   else if (msg?.content?.op === 'clientId' && msg?.repliable) msg.reply(this.user?.id)
    //   else if (msg?.content?.op === 'setPresence') {
    //     this.user?.setPresence({
    //       activities: [
    //         {
    //           name: msg?.content?.data,
    //           type: 2
    //         }
    //       ]
    //     })
    //   } else if (msg?.content?.op === 'clearQueues') {
    //     for (const player of this.kazagumo.players.values()) {
    //       player.setLoop('none')
    //       player.queue.clear()
    //     }
    //   } else if (msg?.content?.op === 'destroyAll') {
    //     for (const player of this.kazagumo.players.values()) {
    //       player.destroy()
    //     }
    //   }
    // })

    return this.constructor.name
  }

  async exit() {
    //
  }
}
