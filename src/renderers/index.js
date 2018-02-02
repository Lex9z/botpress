import _ from 'lodash'
import Promise from 'bluebird'

import Engine from './engine'
import Proactive from './proactive'

module.exports = ({ logger, middlewares, db, contentManager }) => {
  const processors = {} // A map of all the platforms that can process outgoing messages
  const renderers = {} // A map of all the registered renderers

  const registerChannel = ({ platform, processOutgoing }) => {
    if (!_.isString(platform)) {
      throw new Error(`[Renderers] Platform must be a string, got: ${platform}.`)
    }
    if (processors[platform]) {
      throw new Error(`[Renderers] Platform should only be registered once, platform: ${platform}.`)
    }
    if (!_.isFunction(processOutgoing)) {
      throw new Error(`[Renderers] processOutgoing must be a function, platform: ${platform}.`)
    }

    logger.verbose(`[Renderers] Enabled for ${platform}.`)

    processors[platform] = processOutgoing
  }

  const register = (name, rendererFn) => {
    if (!_.isString(name)) {
      throw new Error(`Renderer name must be a string, received ${name}`)
    }
    if (name.startsWith('#')) {
      name = name.substr(1)
    }

    renderers[name] = rendererFn
  }

  const unregister = name => {
    if (!_.isString(name)) {
      throw new Error(`Renderer name must be a string, received ${name}`)
    }
    if (name.startsWith('#')) {
      name = name.substr(1)
    }
    if (!renderers[name]) {
      throw new Error(`Unknown renderer "${name}"`)
    }
    delete renderers[name]
  }

  const isRegistered = name => {
    if (!_.isString(name)) {
      throw new Error(`Renderer name must be a string, received ${name}`)
    }
    if (name.startsWith('#')) {
      name = name.substr(1)
    }
    return !!renderers[name]
  }

  const invoke = ({ rendererFn, rendererName, context, outputPlatform, incomingEvent = null }) => {
    // TODO throw if incomingEvents null <<<==== MOCK IT

    const options = {
      throwIfNoPlatform: true,
      currentPlatform: outputPlatform
    }

    return Engine({ rendererFn, rendererName, context, options, processors, incomingEvent })
  }

  const doSendContent = (rendererFn, { rendererName, context, outputPlatform, incomingEvent }) => {
    const messages = invoke({ rendererFn, rendererName, context, outputPlatform, incomingEvent })

    return Promise.mapSeries(messages, message => {
      if (message.__internal) {
        if (message.type === 'wait') {
          return Promise.delay(message.wait)
        }
      } else {
        return middlewares.sendOutgoing(message)
      }
    })
  }

  const sendContent = async (incomingEvent, rendererName, additionalData = {}) => {
    rendererName = rendererName.startsWith('#') ? rendererName.substr(1) : rendererName

    const initialData = {}

    if (rendererName.startsWith('!')) {
      const itemName = rendererName.substr(1)
      const contentItem = await contentManager.getItem(itemName)

      if (!contentItem) {
        throw new Error(`Could not find content item with ID "${itemName}" in the Content Manager`)
      }

      const { categoryId: itemCategoryId } = contentItem

      const itemCategory = contentManager.getCategorySchema(itemCategoryId)

      if (!itemCategory) {
        throw new Error(
          `Could not find category "${itemCategoryId}" in the Content Manager` + ` for item with ID "${itemName}"`
        )
      }

      const itemRenderer = itemCategory.renderer
      if (!_.isString(itemRenderer) || !itemRenderer.startsWith('#') || itemRenderer.length <= 1) {
        throw new Error(`Invalid renderer '${itemRenderer}' in category '${itemCategoryId}' of Content Manager.
         A renderer must start with '#'`)
      }

      rendererName = itemRenderer.substr(1)
      Object.assign(initialData, contentItem.data)
    }

    // TODO Add more context
    const fullContext = Object.assign(
      {},
      initialData,
      {
        user: incomingEvent.user,
        originalEvent: incomingEvent
      },
      additionalData
    )

    const renderer = renderers[rendererName]

    if (!renderer) {
      const error = `[Renderer] Renderer not defined (#${rendererName})`
      logger.error(error)
      throw new Error(error)
    }

    return doSendContent(renderer, {
      rendererName,
      context: fullContext,
      outputPlatform: incomingEvent.platform,
      incomingEvent
    })
  }

  const processIncoming = (event, next) => {
    event.reply = (rendererName, additionalData = {}) => {
      return sendContent(event, rendererName, additionalData)
    }

    next()
  }

  const incomingMiddleware = {
    name: 'rendering.instrumentation',
    type: 'incoming',
    order: 2, // Should really be first
    module: 'botpress',
    description: 'Built-in Botpress middleware that adds a `.reply` to events. Works with renderers.',
    handler: processIncoming
  }

  const proactiveMethods = Proactive({ sendContent, db })

  return {
    registerChannel,
    registerConnector: registerChannel, // DEPRECATED Use "channel" instead of "connector"
    register,
    unregister,
    isRegistered,
    incomingMiddleware,
    ...proactiveMethods
  }
}