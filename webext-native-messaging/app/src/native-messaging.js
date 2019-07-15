'use strict';

const constants = require('./constants');
const os = require('os');
const stream = require('stream');
const util = require('./util');
const uuidv4 = require('uuid/v4');


// UINT32 size in bytes.
const UINT32_SIZE = 4;

// Notes:
// See: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging
// Each message is serialized using JSON, UTF-8 encoded and is preceded with a
// 32-bit value containing the message length in native byte order.
// The maximum size of a single message from the application is 1 MB.
// The maximum size of a message sent to the application is 4 GB.
//
// For our usage, we thus receive messages as-is from the extension, and handle
// possible fragments for what is sent to the extension.

// Split size.
// Max message size is supposed to be 1MB (raw). When splitting into fragments
// we need to take into account extra space for fragment message and fragment
// content escaping (since json as text is embedded in another json).
const MSG_SPLIT_SIZE = 512 * 1024;

const FRAGMENT_KIND_START = 'start';
const FRAGMENT_KIND_CONT = 'cont';
const FRAGMENT_KIND_END = 'end';


// Transforms native message input (bytes) to objects
class NativeSource extends stream.Transform {

  // We receive raw messages (from stdin):
  //  - uint32 (native order): message size
  //  - UTF-8 JSON message
  // JSON is decoded into an object and pushed to the next stage.

  constructor() {
    // We convert bytes to objects
    super({
      readableObjectMode: true
    });
    // Buffered data to parse
    this.buffer = Buffer.alloc(0);
    this.messageLength = -1;
    this.readUInt32 = Buffer.prototype['readUInt32' + os.endianness()];
  }

  _transform(chunk, encoding, done) {
    // Process RAW data as it arrives.
    // Process is as follow:
    //  - buffer data until we can parse it
    //  - until incoming message size is fully received and parsed, messageLength is negative
    //  - until incoming message is fully received and parsed, messageLength is positive
    this.buffer = Buffer.concat([this.buffer, chunk]);

    // Process received data
    while(true) {
      // Process message size when applicable
      if ((this.messageLength < 0) && (this.buffer.length >= UINT32_SIZE)) {
        // Message size received, decode it
        this.messageLength = this.readUInt32.call(this.buffer, 0);
        this.buffer = this.buffer.slice(UINT32_SIZE);
      }

      // Process message when applicable
      if ((this.messageLength >= 0) && (this.buffer.length >= this.messageLength)) {
        // Message received, decode it
        var message = this.buffer.slice(0, this.messageLength);
        this.buffer = this.buffer.slice(this.messageLength);
        // Reset message size to prepare for next message
        this.messageLength = -1;
        var obj = JSON.parse(message.toString());
        this.push(obj);
        // Loop to process next message is possible
        continue;
      }
      // Not enough received data, wait for more
      break;
    }
    done();
  }

}

// Transform objects into native messages output (bytes)
class NativeSink extends stream.Writable {

  // We receive application objects. Each object is converted to JSON and
  // written (on stdout) as a raw message:
  //  - uint32 (native order): message size
  //  - UTF-8 JSON message
  // If the JSON exceeds the (native message) size limit, it is split into
  // smaller parts, embedded into smaller objects (marked as fragments and
  // linked with a correlation id) then sent as native messages.

  constructor(app) {
    // We receive objects
    super({
      objectMode: true
    });
    this.stdout_write = app.stdout_write;
    // endian-dependant Buffer uint32 write function
    this.writeUInt32 = Buffer.prototype['writeUInt32' + os.endianness()];
  }

  _write(msg, encoding, done) {
    this.writeMessage(msg);
    done();
  }

  writeMessage(msg, noSplit) {
    var json;
    // Some objects (and thus the message itself) may not be turned into a JSON
    // string (or even a bare string).
    // In this case, do our best and check each field:
    //  - keep the valid fields
    //  - remove the fields that cannot be serialized
    //  - add error field (string) listing the problematic fields (and content)
    //    that were removed
    //    - in case the message had an 'error' field, use another field name
    try {
      json = JSON.stringify(msg);
    } catch (unused) {
      var error = 'Could not JSON.stringify message';
      Object.keys(msg).forEach(key => {
        var value = msg[key];
        try {
          JSON.stringify(value);
        } catch (unused) {
          // Belt and suspenders: in case formatObject fails too ...
          try {
            error += ` key=<${key}> value=<${util.formatObject(value)}>`;
          } catch (error) {
            error += ` key=<${key}> value=<(failed to stringify)>`;
          }
          delete(msg[key]);
        }
      });
      // Do not overwrite pre-existing 'error' field.
      if (msg.error === undefined) msg.error = error;
      else msg.jsonError = error;
      // Belt and suspenders: in case cleaned message still fails ...
      try {
        json = JSON.stringify(msg);
      } catch(unused) {
        json = JSON.stringify({
          correlationId: msg.correlationId,
          error: 'Could not JSON.stringify message, nor clean it'
        });
      }
    }

    // When applicable, split JSON into multiple fragments to send.
    if (!noSplit && (json.length > MSG_SPLIT_SIZE)) {
      try {
        this.writeFragments(msg, json);
      } catch (error) {
        console.error(error);
      }
      return;
    }

    // Prepare to send the message (uint32 size and JSON content).
    var buf = Buffer.from(json);
    var len = Buffer.alloc(UINT32_SIZE);
    this.writeUInt32.call(len, buf.length, 0);
    // Send the native message (size then content).
    this.stdout_write(len);
    this.stdout_write(buf);
  }

  writeFragments(msg, json) {
    var length = json.length;
    // We will send 'fragments' linked by a correlation id.
    var fragment = {
      feature: msg.feature,
      kind: msg.kind,
      correlationId: uuidv4()
    };

    // Prepare and send each fragment.
    for (var offset = 0; offset < length; offset += MSG_SPLIT_SIZE) {
      fragment.content = json.slice(offset, offset + MSG_SPLIT_SIZE);
      fragment.fragment = (offset == 0
        ? constants.FRAGMENT_KIND_START
        : (offset + MSG_SPLIT_SIZE >= length
            ? constants.FRAGMENT_KIND_END
            : constants.FRAGMENT_KIND_CONT
          )
      );
      this.writeMessage(fragment, true);
    }
  }

}

// Handles application messages
class NativeHandler extends stream.Writable {

  // We receive objects to handle by the application.
  // The application may return an asynchronous response, in which case we
  // automatically propagate the incoming message information: feature, kind
  // and correlation id if any.
  // If the application response is not an object, it is ignored.
  // Errors are propagated.

  constructor(handler, app) {
    // We receive objects
    super({
      objectMode: true
    });
    this.handler = handler;
    this.app = app;
  }

  _write(msg, encoding, done) {
    var self = this;
    var r = self.handler(self.app, msg);
    if (r instanceof Promise) {
      var response = {
        feature: msg.feature,
        kind: msg.kind,
        correlationId: msg.correlationId
      };
      r.then(v => {
        if (typeof(v) !== 'object') return;
        self.app.postMessage(Object.assign(response, v));
      }).catch(error => {
        self.app.postMessage(Object.assign(response, {error: error}));
      });
    }
    done();
  }

}

// Native application (plumbing)
class NativeApplication {

  constructor(handler) {
    var self = this;
    // Wrap stdout/stderr to transform it into (log) native messages
    self.stdout_write = process.stdout.write.bind(process.stdout);
    self.wrapOutput(process.stdout, 'info');
    self.wrapOutput(process.stderr, 'error');

    // Wrap console logging to transform it into (log) native messages
    for (var level of ['log', 'debug', 'info', 'warn', 'error']) {
      self.wrapConsole(level);
    }

    // Native messaging:
    // Create a sink to transform objects into messages.
    // (also wraps stdout/stderr to transform it into (log) native messages)
    // Process stdin to decode incoming native messages and process them.
    // (output messages are written to sink when needed)

    self.sink = new NativeSink(self);
    process.stdin
      .pipe(new NativeSource())
      .pipe(new NativeHandler(handler, self));

    // Once EOS is reached (input or output), it is time to stop.
    process.stdin.once('end', () => self.exit());
    self.sink.once('close', () => self.exit());
    // (makes sure we close the sink upon ending it)
    self.sink.once('finish', () => self.sink.destroy());

    // See: https://nodejs.org/api/process.html#process_event_uncaughtexception
    // Uncaught exceptions should be written on stderr. we push stderr lines
    // as log messages to send, but the application may exit before those are
    // fully processed.
    // So handle uncaught exceptions to make sure pending messages are fully
    // sent before exiting. Also mark the message for user notification.
    process.on('uncaughtException', (error) => {
      // Notify this issue (trash any problem doing so).
      try {
        self.notify({
          level: 'error',
          title: 'Uncaught exception',
          error: error
        });
      } catch { }
      // End the stream before exiting with the nominal value.
      self.shutdown(1);
    });
  }

  shutdown(code) {
    var self = this;
    if (self.sink !== undefined) {
      // Belt and suspenders: force exit after timeout.
      if (code !== undefined) process.exitCode = code;
      setTimeout(() => {
        self.exit();
      }, 10000);
      // Flush output before exiting.
      self.sink.end();
    } else {
      // There is no output, exit right now.
      self.exit(code);
    }
  }

  exit(code) {
    process.exit(code);
  }

  postMessage(msg) {
    this.sink.write(msg);
  }

  wrapOutput(output, level) {
    var self = this;
    output.write = function (chunk, encoding, done) {
      self.postMessage({
        feature: constants.FEATURE_APP,
        kind: constants.KIND_CONSOLE,
        level: level,
        content: chunk.replace(/\r?\n+$/, '')
      });
      done();
    }
  }

  wrapConsole(level) {
    var self = this;
    console[level] = function (...args) {
      self.postMessage({
        feature: constants.FEATURE_APP,
        kind: constants.KIND_CONSOLE,
        level: level,
        args: args
      });
    }
  }

  notify(details) {
    this.postMessage({
      feature: constants.FEATURE_APP,
      kind: constants.KIND_NOTIFICATION,
      details: details
    });
  }

}


exports.NativeApplication = NativeApplication;
