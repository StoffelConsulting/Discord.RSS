const logLinkErrs = require('../config.js').log.linkErrs
const connectDb = require('./db/connect.js')
const log = require('../util/logger.js')
const FeedFetcher = require('../util/FeedFetcher.js')
const RequestError = require('../structs/errors/RequestError.js')
const FeedParserError = require('../structs/errors/FeedParserError.js')
const LinkLogic = require('./logic/LinkLogic.js')
const debug = require('../util/debugFeeds.js')
const DataDebugger = require('../structs/DataDebugger.js')
const dbCmds = require('./db/commands.js')

async function getFeed (data, callback) {
  const { link, rssList, headers, toDebug } = data
  const linkHeaders = headers[link]
  const fetchOptions = {}
  if (linkHeaders) {
    if (!linkHeaders.lastModified || !linkHeaders.etag) {
      throw new Error(`Headers exist for a link, but missing lastModified and etag (${link})`)
    }
    fetchOptions.headers = {
      'If-Modified-Since': linkHeaders.lastModified,
      'If-None-Match': linkHeaders.etag
    }
  }
  let calledbacked = false
  try {
    if (toDebug) {
      log.debug.info(`${link}: Fetching URL`)
    }
    const { stream, response } = await FeedFetcher.fetchURL(link, fetchOptions)
    if (response.status === 304) {
      callback()
      if (toDebug) {
        log.debug.info(`${link}: 304 response, sending success status`)
      }
      return process.send({ status: 'success', link })
    } else {
      const lastModified = response.headers['last-modified']
      const etag = response.headers['etag']

      if (lastModified && etag) {
        process.send({ status: 'headers', link, lastModified, etag })
        if (toDebug) {
          log.debug.info(`${link}: Sending back headers`)
        }
      }
    }

    callback()
    calledbacked = true
    if (toDebug) {
      log.debug.info(`${link}: Parsing stream`)
    }
    const { articleList } = await FeedFetcher.parseStream(stream, link)
    if (articleList.length === 0) {
      if (toDebug) {
        log.debug.info(`${link}: No articles found, sending success status`)
      }
      return process.send({ status: 'success', link: link })
    }
    const logic = new LinkLogic({ articleList, ...data })
    const result = data.feedData ? await logic.runFromMemory() : await logic.runFromMongo()
    result.newArticles.forEach(article => {
      if (toDebug) {
        log.debug.info(`${link}: Sending article status`)
      }
      process.send({ status: 'article', article })
    })
    process.send({
      status: 'success',
      link: result.link,
      memoryCollection: data.memoryCollection,
      memoryCollectionID: data.memoryCollectionID
    })
  } catch (err) {
    if (err instanceof RequestError || err instanceof FeedParserError) {
      if (logLinkErrs || toDebug) {
        log.cycle.warning(`Skipping ${link}`, err)
      }
    } else {
      log.cycle.error(`Cycle logic (${link})`, err, true)
    }
    if (toDebug) {
      log.debug.info(`${link}: Sending failed status`)
    }
    process.send({ status: 'failed', link: link, rssList: rssList })
    if (!calledbacked) {
      callback()
    }
    calledbacked = true
  }
}

function mapArticleDocumentsByURL (articles) {
  /** @type {Map<string, Object<string, any>[]} */
  const map = new Map()
  for (const article of articles) {
    const feedURL = article.feedURL
    if (!map.has(feedURL)) {
      map.set(feedURL, [article])
    } else {
      map.get(feedURL).push(article)
    }
  }
  return map
}

process.on('message', m => {
  const currentBatch = m.currentBatch
  const { debugFeeds, debugLinks, scheduleName, shardID } = m
  debug.feeds = new DataDebugger(debugFeeds || [], 'feeds-processor')
  debug.links = new DataDebugger(debugLinks || [], 'links-processor')
  dbCmds.findAll(shardID, scheduleName)
  connectDb(true)
    .then(() => dbCmds.findAll(shardID, scheduleName))
    .then(articles => {
      const docsByURL = mapArticleDocumentsByURL(articles)
      const len = Object.keys(currentBatch).length
      let c = 0
      for (const link in currentBatch) {
        const docs = docsByURL.get(link) || []
        const toDebug = debug.links.has(link)
        if (toDebug) {
          log.debug.info(`${link}: Isolated processor received link in batch`)
        }
        const rssList = currentBatch[link]
        let uniqueSettings
        for (const modRssName in rssList) {
          if (rssList[modRssName].advanced && Object.keys(rssList[modRssName].advanced).length > 0) {
            uniqueSettings = rssList[modRssName].advanced
          }
        }
        getFeed({ ...m, link, rssList, uniqueSettings, toDebug, docs }, () => {
          if (++c === len) process.send({ status: 'batch_connected' })
        })
      }
    })
    .catch(err => log.general.error(`isolatedMethod db connection`, err))
})
