const _ = require('lodash');
const async = require('async');
const Segment = require('analytics-node');
const loggingTools = require('auth0-log-extension-tools');
const config = require('../lib/config');
const logger = require('../lib/logger');

module.exports = (storage) =>
  (req, res, next) => {
    const wtHead = (req.webtaskContext && req.webtaskContext.headers) || {};
    const isCronPost = (req.body && req.body.schedule && req.body.state === 'active');
    const isCronGet = (wtHead.origin === 'https://manage.auth0.com' && wtHead['if-none-match']);
    if (!isCronPost && !isCronGet) {
      return next();
    }

    const analytics = new Segment(config('SEGMENT_KEY'));

    const onLogsReceived = (logs, callback) => {
      if (!logs || !logs.length) {
        return callback();
      }

      logger.info(`Sending ${logs.length} logs to Segment.`);

      async.eachLimit(logs, 10, (log, cb) => {
        if (!log.user_id) {
          return cb();
        }

        return req.auth0.users.get({ id: log.user_id })
          .then((user) => {
            analytics.track({
              userId: log.user_id,
              event: loggingTools.logTypes.get(log.type),
              properties: _.extend({}, user.user_metadata, _.omit(user, ['user_metadata', 'app_metadata']), user.app_metadata)
            }, cb);
          })
          .catch((err) => {
            if(err.statusCode === 404) {
              return analytics.track({
                userId: log.user_id,
                event: loggingTools.logTypes.get(log.type),
                properties: {}
              }, cb);
            }

            return cb(err);
          });
      }, callback);
    };

    const slack = new loggingTools.reporters.SlackReporter({
      hook: config('SLACK_INCOMING_WEBHOOK_URL'),
      username: 'auth0-logs-to-segment',
      title: 'Logs To Segment'
    });

    const options = {
      domain: config('AUTH0_DOMAIN'),
      clientId: config('AUTH0_CLIENT_ID'),
      clientSecret: config('AUTH0_CLIENT_SECRET'),
      batchSize: config('BATCH_SIZE'),
      startFrom: config('START_FROM'),
      logTypes: [ 's', 'ss', 'f' ]
    };

    const auth0logger = new loggingTools.LogsProcessor(storage, options);

    return auth0logger
      .run(onLogsReceived)
      .then(result => {
        slack.send(result.status, result.checkpoint);
        res.json(result);
      })
      .catch(err => {
        slack.send({ error: err, logsProcessed: 0 }, null);
        next(err);
      });
  };
