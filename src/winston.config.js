module.exports = function () {
    if (process.env.NODE_ENV === 'development') {
        let check = global.CLOUD_LOGGER_SINGLETON_CHECK
        if (check) check++
        else check = 1

        if (check > 1) Log.error(`Module 'cloud_logger' has ${check} instances.`)
    }

    const winston = require(`winston`),
        { LoggingWinston: GCloud } = require(`@google-cloud/logging-winston`),
        { MongoDB } = require(`winston-mongodb`),
        mongo = require(`mongodb`),
        colors = require(`colors`),
        genStack = require(`./modules/retro-gen-stack`)

    const LOG_LEVEL_NAME = process.env.LOGGING || `info`,
        LOG_LEVELS = {
            error: `error`,
            warn: `warn`,
            info: `info`,
            verbose: `verbose`,
            debug: `debug`,
            silly: `silly`
        },
        { createLogger, format, transports } = winston,
        { combine, printf } = format,
        http_transports = [],
        log_transports = []

    let check_log_level_name = level => {
        if (!LOG_LEVELS[level]) {
            console.error(`Bad log level passed: ${level}`)
            return false
        }
        return true
    }

    let log_level = check_log_level_name(LOG_LEVEL_NAME)
        ? LOG_LEVELS[LOG_LEVEL_NAME]
        : LOG_LEVELS[`info`]

    function humanFileSize(bytes, si) {
        var thresh = si ? 1000 : 1024
        if (Math.abs(bytes) < thresh) {
            return bytes + ` B`
        }
        var units = si
            ? [`kB`, `MB`, `GB`, `TB`, `PB`, `EB`, `ZB`, `YB`]
            : [`KiB`, `MiB`, `GiB`, `TiB`, `PiB`, `EiB`, `ZiB`, `YiB`]
        var u = -1
        do {
            bytes /= thresh
            ++u
        } while (Math.abs(bytes) >= thresh && u < units.length - 1)
        return bytes.toFixed(1) + ` ` + units[u]
    }

    const http_format = printf(info => {
        let status = info.httpRequest.status

        if (status >= 200 && status < 300) status = colors.green(status)
        else if (status >= 300 && status < 400) status = colors.blue(status)
        else if (status >= 400 && status < 500) status = colors.red(status)
        else if (status >= 300 && status < 400) status = colors.yellow(status)

        return `${info.level}: ${colors.cyan(
            info.httpRequest.requestMethod
        )} ${status} ${humanFileSize(info.httpRequest.responseSize, true) ||
        0} ${info.httpRequest.latency.nanos / 1e6} ms ${
            info.httpRequest.requestUrl
            } ${info.jsonMessage ? `(${info.jsonMessage})` : ``}`
    })

    const http_format_mongo = format(info => {
        info.message = info.httpRequest.requestMethod
        info.meta = info.httpRequest
        return info
    })

    const formatErrorConverter = format(info => {
        if (info.stack) {
            info.message = info.stack
            delete info.stack
        }
        return info
    })

    if (
        process.env.NODE_ENV === `production` ||
        process.env.NODE_ENV === `gusadev`
    ) {
        gcloud = new GCloud({
            logName: `winston_log`,
            resource: {
                type: `gae_app`,
                labels: {
                    module_id: process.env.GAE_SERVICE
                        ? process.env.GAE_SERVICE
                        : `local-development`,
                    version_id: process.env.GAE_VERSION
                        ? process.env.GAE_VERSION
                        : `local-dev-${require(`git-user-name`)()}`
                }
            }
        })

        log_transports.push(gcloud)
        http_transports.push(gcloud)
    } else {
        log_transports.push(
            new transports.Console({
                format: combine(
                    formatErrorConverter(),
                    format.colorize(),
                    format.simple()
                )
            })
        )
        http_transports.push(
            new transports.Console({
                format: combine(format.colorize(), http_format)
            })
        )
    }

    let http_logger = createLogger({
        level: log_level,
        transports: http_transports
    })

    let logger = createLogger({
        level: log_level,
        exitOnError: false,
        transports: log_transports
    })

    global.Log = logger

    /**
     * Initializes the mongo db Transport
     */
    async function init_mongo() {
        if (process.env.LOG_MONGO) {
            try {
                let con = await mongo.connect(process.env.LOG_MONGO, { autoReconnect: true, useNewUrlParser: true })

                logger.add(
                    new MongoDB({
                        db: con,
                        level: log_level,
                        label: process.env.GAE_SERVICE || undefined
                    })
                )
                http_logger.add(
                    new MongoDB({
                        db: con,
                        level: log_level,
                        label: process.env.GAE_SERVICE || undefined,
                        format: http_format_mongo()
                    })
                )
            } catch (err) {
                Log.error(err)
            }
        }
    }
    init_mongo()

    Log.err_bak = Log.error
    Log.error = function (err, ...args) {
        if (err !== Object(err)) {
            err = genStack(err)
        } else if (!err.stack) {
            args.push(err)
            err = err.message
                ? genStack(err.message)
                : genStack(`No Object Message`)
        }

        Log.log({
            level: `error`,
            message: err.message,
            stack: err.stack,
            ...args
        })
    }

    function parseJwt(token) {
        try {
            let base64Url = token.split(`.`)[1]
            let base64 = base64Url.replace(`-`, `+`).replace(`_`, `/`)
            return JSON.parse(Buffer.from(base64, `base64`).toString(`ascii`))
        } catch (err) {
            return undefined
        }
    }

    // Express middleware
    logger.express = function (req, res, next) {
        let filter = [`/api/liveness_check`, `/api/readiness_check`].includes(
            req.originalUrl
        )

        let oldSend = res.send,
            message

        res.send = function (data) {
            try {
                message = JSON.parse(arguments[0]).message
            } catch (err) {
            } finally {
                oldSend.apply(res, arguments)
            }
        }

        const start = process.hrtime()
        res.on(`finish`, function () {
            if (!(filter && !(req.baseUrl + req.url !== req.originalUrl))) {
                new Promise(() => {
                    let statusCode =
                        req.baseUrl + req.url.replace(`/?`, `?`) !== req.originalUrl
                            ? 404
                            : res.statusCode
                    let level = `info`
                    if (statusCode >= 100) {
                        level = `info`
                    }
                    if (statusCode >= 400) {
                        level = `warn`
                    }
                    if (statusCode >= 500) {
                        level = `error`
                    }

                    let user = undefined
                    try {
                        user = parseJwt(
                            req.headers[`authorization`].split(` `, 2)[1]
                        )
                    } catch (err) {
                        user = `No JWT token sent with request.`
                    }
                    const end = process.hrtime()
                    let duration = {
                        seconds: end[0] - start[0],
                        nanos: end[1] - start[1]
                    }

                    if (duration.seconds < 0 && duration.nanos > 0) {
                        duration.seconds += 1
                        duration.nanos -= 1000000000
                    } else if (duration.seconds > 0 && duration.nanos < 0) {
                        duration.seconds -= 1
                        duration.nanos += 1000000000
                    }

                    let body = {}
                    Object.assign(body, req.body)
                    if (body.password)
                        delete body.password

                    let metaData = {
                        user: user,
                        jsonMessage: message,
                        requestBody: body || null,
                        httpRequest: {
                            requestMethod: req.method,
                            requestUrl: req.originalUrl,
                            status: statusCode,
                            remoteIp: req.client.remoteAddress,
                            latency: duration,
                            userAgent: req.headers[`user-agent`],
                            requestSize: req.socket.bytesRead,
                            responseSize: req.socket.bytesWritten,
                            requestBody:
                                req.method === `POST` ? body : undefined
                        }
                    }

                    if (req.originalUrl === `/api/auth/login`)
                        metaData[`login_attempt_user`] = req.body.email
                    http_logger.log(
                        level,
                        `${req.method} ${statusCode} ${humanFileSize(res._contentLength, true) || 0} ${end} ms ${req.originalUrl} `,
                        metaData
                    )
                })
            }
        })
        next()
    }

    return logger
}