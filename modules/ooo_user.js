/// <reference path='../typings/tsd.d.ts' />
var logger = require('./logger'),
    moment = require('moment'),
    chrono = require('chrono-node'),
    RSVP = require('rsvp'),
    nconf = require('../config.js');

var https = require("https");
var MongoClient = require('mongodb').MongoClient;
var mongo_url = nconf.get("mongo_connection");

function __isOOO(email, cb) {

  console.log("Checking OOO " + email + "...........");

  var startTime = new Date();
  startTime.setHours(0,0,0,0);
  var endTime = new Date();
  endTime.setHours(23,59,59,0);

  MongoClient.connect(mongo_url, function(err, db) {
    if (err) {
      console.log(err);
      cb(null, err);
    } else {
      console.log("Connected to db..");
      var collection = db.collection('users');
      collection.find({}).toArray(function(err, users) {
        var found = false;
        console.log("Processing users.. (" + users.length + ")");
        for (var i in users) {
          var user = users[i];
          console.log(user);
          if (user.email == email) {

            found = true;
            console.log("Found user match...");

            var options = {
              hostname: 'outlook.office.com',
              path: '/api/v1.0/Me/CalendarView?startDateTime=' + startTime.toISOString() + '&endDateTime=' + endTime.toISOString(),
              headers: { "Authorization": "Bearer " + user.accessToken }
            };

            var body = '';
            https.get(options, function(response) {

              response.on("data", function(data) {
                body += data;
              });

              response.on("end", function() {
                var now = Date.now();  
                body = JSON.parse(body);
                var events = body.value; 
                for (var i in events) {
                  var e = events[i];
                  var start = new Date(e.Start);
                  var end = new Date(e.End);
                  if (start.getTime() <= now && end.getTime() > now && 
                      (e.Subject.indexOf("ooo") != -1 || e.Subject.indexOf("oof") != -1)) {
                    cb(null, true);
                    return;
                  }
                }
                cb(null, false);
              });
            });
          }
        }
        if (!found) {
          cb("user not found");
        }
      });
    } 
  });
}

/**
 * @module OOO_User
 */
var OOO_User = (function () {
    /**
     * Constructor
     *
     * @constructor
     * @param {string} username the name of the user
     */
    function OOO_User(username, email) {
        this.email = email;
        this.username = username;
        this.STATUS_UNCONFIRMED = 'unconfirmed';
        this.STATUS_AWAITING_CONFIRMATION = 'awaiting_confirmation';
        this.STATUS_AWAITING_MESSAGE = 'awaiting_message';
        this.STATUS_REGISTERED = 'registered';
        this.STATUS_AWAITING_DEREGISTER = 'awaiting_deregister';
        this.COMMAND_MESSAGE = 'message';
        this.COMMAND_START = 'start';
        this.COMMAND_END = 'end';
        this.status = this.STATUS_UNCONFIRMED;
        this.MESSAGE_TIMEOUT = 60000; // Five minutes
        this.DEREGISTER_TIMEOUT = 60000; // Five minutes
        this.POSITIVE_REGEXP = /(yes|ok|sure|yeah)/i;
        this.NEGATIVE_REGEXP = /(no|negative)/i;
        this.last_communication = moment();
    }
    /**
     * Check if the user is out of the office
     *
     * @return {promise}
     */
    OOO_User.prototype.isOOO = function () {

        var now = moment(),
            self = this;
        return new RSVP.Promise(function (resolve) {
            __isOOO(self.email, function(err, result) {
              if (err) {
                console.log("ERROR fetch OOO status: " + err);
              } else {
                resolve(result);
              }
            });
        });

    };
    /**
     * Gets the ms since last communication
     *
     * @return {integer}
     */
    OOO_User.prototype.lastCommunication = function () {
        return this.last_communication ? moment().diff(this.last_communication) : 0;
    };
    /**
     * Set the user's OOO message and return a response
     *
     * @param {string} message The message to set
     * @return {string} A response for the user
     */
    OOO_User.prototype.setMessage = function (message) {
        this.message = message;
        return 'Setting your OOO Message to:\n' + message;
    };
    /**
     * Set the start of the user's OOO
     *
     * @param {string} start A parsable date/time string
     * @return {string} A response for the user
     */
    OOO_User.prototype.setStart = function (start) {
        var retVal = 'Unable to parse ' + start + ' into a valid date/time';
        var time;
        if (start) {
            time = this.parseDate(start);
        }
        else {
            time = moment();
        }
        if (time.isValid()) {
            this.ooo_start = time;
            retVal = 'You ' + (time.isBefore() ? 'are' : 'will be') + ' marked Out of Office at ' + time.calendar();
        }
        return retVal;
    };
    /**
     * Set the end of the user's OOO
     *
     * @param {string} end A parsable date/time string
     * @return {string} A response for the user
     */
    OOO_User.prototype.setEnd = function (end) {
        var retVal = 'Unable to parse ' + end + ' into a valid date/time';
        var time;
        if (end) {
            time = this.parseDate(end);
        }
        else {
            time = moment();
        }
        if (time.isValid()) {
            this.ooo_end = time;
            if (time.isBefore()) {
                retVal = 'You are no longer marked Out of Office';
            }
            else {
                if (!this.ooo_start) {
                    // Set the start time to now
                    this.ooo_start = moment();
                }
                retVal = 'You are marked Out of Office returning on ' + time.calendar();
            }
        }
        return retVal;
    };
    /**
     * Parse a string into a moment date.
     *
     * @param {string} strDate The date string
     * @return {Moment}
     */
    OOO_User.prototype.parseDate = function (strDate) {
        var pDate = chrono.parseDate(strDate);
        return pDate ? moment(pDate) : moment.invalid();
    };
    /**
     * Parse any commands and their values from a message.
     *
     * @param {string} message The raw message
     * @return {string[]}
     */
    OOO_User.prototype.parseCommands = function (message) {
        var retVal = {};
        var splits = message.split(/(start:|end:|message:)/);
        var curCommand;
        for (var x in splits) {
            if (x % 1 === 0) {
                switch (splits[x].toLowerCase()) {
                    case 'message:':
                    case 'start:':
                    case 'end:':
                        curCommand = splits[x].toLowerCase().replace(':', '');
                        break;
                    default:
                        if (curCommand) {
                            retVal[curCommand] = splits[x].trim();
                        }
                }
            }

        }
        // If no start/end dates, try to parse the message
        if (retVal.hasOwnProperty(this.COMMAND_MESSAGE)) {
            var parsedMessage = chrono.parse(message);
            if (parsedMessage && parsedMessage[0]) {
                if (!retVal.hasOwnProperty(this.COMMAND_START) && parsedMessage[0].start) {
                    retVal[this.COMMAND_START] = this.setStart(parsedMessage[0].start.date().toString());
                }
                if (!retVal.hasOwnProperty(this.COMMAND_END)) {
                    // check for end of first pass parsing
                    if (parsedMessage[0].end) {
                        retVal[this.COMMAND_END] = this.setEnd(parsedMessage[0].end.date().toString());
                    }
                    else {
                        // remove first match and parse again
                        parsedMessage = chrono.parse(message.replace(parsedMessage[0].text, ''));
                        if (parsedMessage && parsedMessage[0] && parsedMessage[0].start) {
                            retVal[this.COMMAND_END] = this.setEnd(parsedMessage[0].start.date().toString());
                        }
                    }
                }
            }
        }
        return retVal;
    };
    /**
     * Return some help flavor text.
     *
     * @return {string}
     */
    OOO_User.prototype.getHelp = function () {
        var retVal = '';
        retVal = '*Out of Office Bot*\n\n';
        retVal += 'I can keep track of when you are out of the office and tell people that mention you.\n\n';
        retVal += '*Usage*:\n';
        retVal += 'to set yourself out of office, say hello and follow my prompts!\n';
        retVal += 'to return to the office once you are back, say hello again!\n\n';
        retVal += '*Direct Commands:*\n';
        retVal += '- message: _string_, To set your Out of Office message\n';
        retVal += '           Example: `message: I am out of the office`\n';
        retVal += '- start:   _string_, A parsable date/time string when your Out of Office begins\n';
        retVal += '           Example: `start: 2015-06-06 8:00`\n';
        retVal += '- end:     _string_, A parsable date/time string when your Out of Office ends\n';
        retVal += '           Example: `end: 2015-06-06 16:00`\n';
        return retVal;
    };
    /**
     * Handle a direct message to the bot
     *
     * @param {string} message
     * @return {string}
     */
    OOO_User.prototype.handleMessage = function (message) {
        var retVal = '',
            commands = this.parseCommands(message),
            self = this;
        console.log('DEBUG1');
        if (message.match(/^help/i)) {
            retVal = this.getHelp();
        }
        else if (Object.keys(commands).length) {
            for (var command in commands) {
                if (command === self.COMMAND_MESSAGE ||
                    command === self.COMMAND_START ||
                    command === self.COMMAND_END) {

                    switch (command) {
                        case self.COMMAND_MESSAGE:
                            retVal += '-' + self.setMessage(commands[command]) + '\n';
                            break;
                        case self.COMMAND_START:
                            retVal += '-' + self.setStart(commands[command]) + '\n';
                            break;
                        case self.COMMAND_END:
                            retVal += '-' + self.setEnd(commands[command]) + '\n';
                            break;
                        default:
                            retVal += '-Error: Unknown comand: ' + command + '\n';
                            logger.error('Unknown command: ' + command);
                    }
                }
            }
            if (retVal) {
                this.status = this.STATUS_REGISTERED;
            }
        }
        else {
            console.log('DEBUG2');
            switch (this.status) {
                case this.STATUS_UNCONFIRMED:
                    this.status = this.STATUS_AWAITING_CONFIRMATION;
                    retVal = 'Hello and welcome to Out of Office Bot!\n';
                    retVal += 'You can ask for help at any time by saying `help`\n\n';
                    retVal += 'I don\'t have you as out of office. Would you like to set yourself Out of Office? [Yes/No]';
                    break;
                case this.STATUS_AWAITING_CONFIRMATION:
                    if (message.match(this.POSITIVE_REGEXP)) {
                        this.status = this.STATUS_AWAITING_MESSAGE;
                        this.setStart();
                        retVal = 'Sweet. You are now marked Out of Office starting now with no message.\n';
                        retVal += 'If you would like to set your Out of Office message, send it to me now';
                    }
                    else if (message.match(this.NEGATIVE_REGEXP)) {
                        this.status = this.STATUS_UNCONFIRMED;
                        retVal = 'Fine. Be that way';
                    }
                    break;
                case this.STATUS_AWAITING_MESSAGE:
                    if (this.lastCommunication() < this.MESSAGE_TIMEOUT) {
                        this.status = this.STATUS_REGISTERED;
                        retVal = this.setMessage(message);
                    }
                    else {
                        // set status to registered and handle it again
                        this.status = this.STATUS_REGISTERED;
                        retVal = this.handleMessage(message);
                    }
                    break;
                case this.STATUS_REGISTERED:
                    retVal = 'Hello! I have you marked as OOO. Would you like to turn that off? [Yes/No]';
                    this.status = this.STATUS_AWAITING_DEREGISTER;
                    break;
                case this.STATUS_AWAITING_DEREGISTER:
                    if (this.lastCommunication() < this.MESSAGE_TIMEOUT) {
                        if (message.match(this.POSITIVE_REGEXP)) {
                            this.status = this.STATUS_UNCONFIRMED;
                            this.ooo_start = null;
                            this.ooo_end = null;
                            retVal = 'Welcome back! You are no longer marked as out of the office.';
                        }
                        else if (message.match(this.NEGATIVE_REGEXP)) {
                            this.status = this.STATUS_REGISTERED;
                            retVal = 'Ok, then get out of here!';
                        }
                    }
                    else {
                        retVal = 'I haven\'t heard from you in a while? Are you trying to return to the office? [Yes/No]';
                    }
                    break;
                default:
                    logger.error('Unknown status: ' + this.status);
                    this.status = this.STATUS_UNCONFIRMED;
            }
        }
        this.last_communication = moment();
        return retVal;
    };
    return OOO_User;
})();
module.exports = OOO_User;
