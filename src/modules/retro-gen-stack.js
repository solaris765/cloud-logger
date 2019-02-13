const stack = require(`callsite`)

class RetroGeneratedError extends Error {
    constructor(message, object) {
        super(message)
        this.name = this.constructor.name
        this.meta = object
    }
}

function format(err, frames) {
    var lines = [err.toString()]

    lines.push.apply(
        lines,
        frames.map(function(frame) {
            return `    at ` + frame.toString()
        })
    )

    return lines.join(`\n`)
}

module.exports = function(message, object) {
    let result = stack().filter(frame => {
        let filename = frame.getEvalOrigin()
        return filename
            ? !(
                  filename.includes(`retro-gen-stack.js`) ||
                  filename.includes(`winston.config.js`)
              )
            : true
    })

    let err = new RetroGeneratedError(message, object)
    err.stack = format(err, result)

    return err
}
