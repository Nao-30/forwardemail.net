/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

const Boom = require('@hapi/boom');
const delay = require('delay');
const ipaddr = require('ipaddr.js');
const isFQDN = require('is-fqdn');
const isSANB = require('is-string-and-not-blank');
const mongoose = require('mongoose');
const ms = require('ms');
const sharedConfig = require('@ladjs/shared-config');
const { Octokit } = require('@octokit/core');

const routes = require('../routes');

const cookieOptions = require('./cookies');
const env = require('./env');
const koaCashConfig = require('./koa-cash');

const config = require('.');

const createTangerine = require('#helpers/create-tangerine');
const i18n = require('#helpers/i18n');
const isErrorConstructorName = require('#helpers/is-error-constructor-name');
const logger = require('#helpers/logger');
const parseRootDomain = require('#helpers/parse-root-domain');

const octokit = new Octokit({
  auth: env.GITHUB_OCTOKIT_TOKEN
});

let ACTIVE_GITHUB_ISSUES = {};

const RATELIMIT_ALLOWLIST =
  typeof env.RATELIMIT_ALLOWLIST === 'string'
    ? env.RATELIMIT_ALLOWLIST.split(',')
    : Array.isArray(env.RATELIMIT_ALLOWLIST)
    ? env.RATELIMIT_ALLOWLIST
    : [];

let appCss;
let botCss;
let freddyCss;

try {
  appCss = fs.readFileSync(
    path.join(config.buildDir, 'css', 'app.css'),
    'utf8'
  );
} catch (err) {
  logger.error(err);
}

try {
  botCss = fs.readFileSync(
    path.join(config.buildDir, 'css', 'app-bot.css'),
    'utf8'
  );
} catch (err) {
  logger.error(err);
}

try {
  freddyCss = fs.readFileSync(
    path.join(config.buildDir, 'css', 'freddy.css'),
    'utf8'
  );
} catch (err) {
  logger.error(err);
}

async function checkGitHubIssues() {
  try {
    ACTIVE_GITHUB_ISSUES = await octokit.request(
      'GET /repos/{owner}/{repo}/issues',
      {
        owner: 'forwardemail',
        repo: 'status.forwardemail.net',
        headers: {
          'X-GitHub-Api-Version': '2022-11-28'
        }
      }
    );
    if (
      typeof ACTIVE_GITHUB_ISSUES === 'object' &&
      Array.isArray(ACTIVE_GITHUB_ISSUES.data)
    )
      ACTIVE_GITHUB_ISSUES.data = ACTIVE_GITHUB_ISSUES.data.filter(
        (obj) => obj.user.login === 'titanism'
      );
  } catch (err) {
    logger.fatal(err);
  }
}

// GitHub API is limited to 5K requests per hour
// (if we check every 10 seconds, then that is 360 requests per hour)
// (if we check every minute, then that is 60 requests per hour)
checkGitHubIssues();
setInterval(checkGitHubIssues, 60000);

const defaultSrc = isSANB(process.env.WEB_HOST)
  ? [
      "'self'",
      'data:',
      `*.${process.env.WEB_HOST}:*`,
      process.env.WEB_HOST,
      `${process.env.WEB_HOST}:*`
    ]
  : null;

const reportUri = isSANB(process.env.WEB_URL)
  ? `${process.env.WEB_URL}/report`
  : null;

const sharedWebConfig = sharedConfig('WEB');

module.exports = (redis) => ({
  ...sharedWebConfig,
  ...config,
  rateLimit: {
    ...sharedWebConfig.rateLimit,
    ...config.rateLimit
  },
  routes: routes.web,
  logger,
  i18n,
  cookies: cookieOptions,
  meta: config.meta,
  views: config.views,
  koaCash: env.CACHE_RESPONSES ? koaCashConfig(redis) : false,
  redis,
  cacheResponses: env.CACHE_RESPONSES
    ? {
        routes: [
          '/.well-known/(.*)',
          '/css/(.*)',
          '/img/(.*)',
          '/js/(.*)',
          '/fonts/(.*)',
          '/browserconfig.xml',
          '/robots.txt',
          '/site.webmanifest'
        ]
      }
    : false,
  serveStatic: {
    hidden: true
  },
  helmet: {
    // TODO: eventually make the CSP only set on PayPal required pages
    contentSecurityPolicy: defaultSrc
      ? {
          directives: {
            defaultSrc,
            connectSrc: [
              ...defaultSrc,
              'plausible.io',
              'www.paypal.com',
              'noembed.com',
              ...(env.NODE_ENV === 'production'
                ? []
                : ['www.sandbox.paypal.com'])
            ],
            fontSrc: [...defaultSrc],
            imgSrc: [
              ...defaultSrc,
              'tracking.qa.paypal.com',
              'www.paypalobjects.com',
              'github.com',
              '*.github.com',
              'githubusercontent.com',
              '*.githubusercontent.com',
              'shields.io',
              '*.shields.io',
              'ytimg.com',
              '*.ytimg.com'
            ],
            styleSrc: [...defaultSrc, "'unsafe-inline'"],
            scriptSrc: [
              ...defaultSrc,
              "'unsafe-inline'",
              'plausible.io',
              'challenges.cloudflare.com',
              'www.paypal.com',
              ...(env.NODE_ENV === 'production'
                ? []
                : ['www.sandbox.paypal.com'])
            ],
            frameSrc: [
              ...defaultSrc,
              'www.youtube.com',
              '*.youtube-nocookie.com',
              'challenges.cloudflare.com',
              'www.paypal.com',
              ...(env.NODE_ENV === 'production'
                ? []
                : ['www.sandbox.paypal.com'])
            ],
            reportUri: reportUri || null
          }
        }
      : null,
    // <https://hstspreload.org/>
    // <https://helmetjs.github.io/docs/hsts/#preloading-hsts-in-chrome>
    hsts: {
      // must be at least 1 year to be approved
      maxAge: ms('1y') / 1000,
      // must be enabled to be approved
      includeSubDomains: true,
      preload: true
    },
    // <https://helmetjs.github.io/docs/referrer-policy>
    // <https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Referrer-Policy>
    referrerPolicy: {
      policy: 'same-origin'
    },
    xssFilter: false
  },
  session: {
    errorHandler(err, type, ctx) {
      if (
        // <https://github.com/luin/ioredis/issues/1716>
        err.message === 'Connection is closed.' ||
        isErrorConstructorName(err, 'MongooseError') ||
        isErrorConstructorName(err, 'MongoError') ||
        isErrorConstructorName(err, 'RedisError')
      ) {
        ctx.logger.fatal(err);
        throw Boom.clientTimeout(ctx.translateError('WEBSITE_OUTAGE'));
      }

      // unknown error
      throw err;
    }
  },
  hookBeforeSetup(app) {
    app.context.resolver = createTangerine(
      app.context.client,
      app.context.logger
    );
    app.use(async (ctx, next) => {
      // since we're on an older helmet version due to koa-helmet
      // <https://github.com/helmetjs/helmet/issues/230>
      ctx.set('X-XSS-Protection', '0');

      // convert local IPv6 addresses to IPv4 format
      // <https://blog.apify.com/ipv4-mapped-ipv6-in-nodejs/>
      if (ipaddr.isValid(ctx.request.ip)) {
        const addr = ipaddr.parse(ctx.request.ip);
        if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress())
          ctx.request.ip = addr.toIPv4Address().toString();
      }

      // if we need to allowlist certain IP which resolve to our hostnames
      if (ctx.resolver) {
        try {
          // maximum of 3s before ac times out
          const abortController = new AbortController();
          const timeout = setTimeout(() => abortController.abort(), 3000);
          const [clientHostname] = await ctx.resolver.reverse(
            ctx.request.ip,
            abortController
          );
          clearTimeout(timeout);
          if (isFQDN(clientHostname)) {
            if (RATELIMIT_ALLOWLIST.includes(clientHostname))
              ctx.allowlistValue = clientHostname;
            else {
              const rootClientHostname = parseRootDomain(clientHostname);
              if (RATELIMIT_ALLOWLIST.includes(rootClientHostname))
                ctx.allowlistValue = rootClientHostname;
            }
          }
        } catch (err) {
          ctx.logger.warn(err);
        }
      }

      return next();
    });
  },
  hookBeforeRoutes(app) {
    // redirect return-path CNAME to main domain
    // (e.g. fe-bounces.forwardemail.net > forwardemail.net)
    app.use((ctx, next) => {
      // if (config.env === 'test' || ctx.hostname === config.webHost)
      if (ctx.hostname !== `${config.returnPath}.${config.webHost}`)
        return next();
      // redirect
      ctx.status = 301;
      let port;
      if (ctx.host.split(':').length === 2) port = ':' + ctx.host.split(':')[1];
      ctx.redirect(`${ctx.protocol}://${config.webHost}${port}${ctx.url}`);
    });

    // if user has OTP remember me then set on session
    app.use((ctx, next) => {
      if (
        ctx.session &&
        ctx.isAuthenticated() &&
        ctx.state.user[config.passport.fields.otpEnabled]
      ) {
        if (ctx.session.otp) {
          if (ctx.session.otp_remember_me) {
            ctx.cookies.set('otp_remember_me', ctx.state.user.id, {
              // Disable signed cookies in NODE_ENV=test
              signed: env.NODE_ENV !== 'test',
              expires: new Date(Date.now() + 31556952000) // one year in ms
            });
          } else {
            // unset cookie
            ctx.cookies.set('otp_remember_me', ctx.state.user.id, {
              // Disable signed cookies in NODE_ENV=test
              signed: env.NODE_ENV !== 'test',
              expires: new Date()
            });
          }
        } else if (ctx.cookies.get('otp_remember_me') === ctx.state.user.id) {
          ctx.session.otp = 'remember_me';
        }
      }

      return next();
    });
  },
  hookBeforePassport(app) {
    app.use(async (ctx, next) => {
      if (
        !ctx.api &&
        ctx.method === 'GET' &&
        (ctx.pathWithoutLocale === '/tti' || ctx.accepts('html'))
      ) {
        // to avoid LCP lighthouse issues
        ctx.state.appCss = appCss;
        ctx.state.botCss = botCss;
        ctx.state.freddyCss = freddyCss;

        // get TTI stats for footer (v1 rudimentary approach)
        ctx.state.tti = false;
        try {
          const tti = await Promise.race([
            ctx.client.get('tti'),
            delay(ms('3s'))
          ]);
          if (tti) {
            ctx.state.tti = JSON.parse(tti);
            ctx.state.tti.created_at = new Date(ctx.state.tti.created_at);
          }
        } catch (err) {
          ctx.logger.error(err);
        }
      }

      return next();
    });

    app.use(async (ctx, next) => {
      let position = 'bottom';

      // TODO: make https://status.forwardemail.net into an env var and replace it everywhere with ripgrep
      if (
        typeof ACTIVE_GITHUB_ISSUES === 'object' &&
        Array.isArray(ACTIVE_GITHUB_ISSUES.data) &&
        ACTIVE_GITHUB_ISSUES.data.length > 0
      ) {
        ctx.state.statusOutage = true;
        if (!ctx.session._gh_issue) {
          ctx.session._gh_issue = true;
          ctx.flash('custom', {
            title: ctx.request.t('Warning'),
            html: `<small>${ctx.translate(
              'ACTIVE_INCIDENT',
              'https://status.forwardemail.net',
              // ACTIVE_GITHUB_ISSUES.data.length > 1
              //   ? 'https://status.forwardemail.net'
              //   : ACTIVE_GITHUB_ISSUES.data[0].html_url ||
              //       'https://status.forwardemail.net',
              ACTIVE_GITHUB_ISSUES.data[0].title ||
                'Please view our status page for more information.'
            )}</small>`,
            type: 'warning',
            toast: true,
            showConfirmButton: false,
            position,
            timer: 10000
          });
          position = 'top';
        }
      } else {
        ctx.session._gh_issue = false;
      }

      // if either mongoose or redis are not connected
      // then render website outage message to users
      const isMongooseDown = mongoose.connections.some(
        (conn) => conn.readyState !== mongoose.ConnectionStates.connected
      );
      const isRedisDown =
        !ctx.client || (ctx.client.status && ctx.client.status !== 'ready');

      if (isMongooseDown || isRedisDown) {
        const obj = {};
        obj.mongoose = mongoose.connections.map((conn) => ({
          id: conn.id,
          readyState: conn.readyState,
          name: conn.name,
          host: conn.host,
          port: conn.port
        }));
        if (ctx?.client?.status && ctx?.client?._getDescription)
          obj.redis = {
            status: ctx.client.status,
            description: ctx.client._getDescription()
          };
        else obj.redis = 'ioredis-mock';
        ctx.logger.fatal(new Error('Website outage'), obj);
      }

      if (
        ctx.method === 'GET' &&
        ctx.accepts('html') &&
        (isMongooseDown || isRedisDown)
      ) {
        ctx.state.statusOutage = true;
        ctx.flash('custom', {
          title: ctx.request.t('Warning'),
          html: `<small>${ctx.translate('WEBSITE_OUTAGE')}</small>`,
          type: 'warning',
          toast: true,
          showConfirmButton: false,
          timer: 5000,
          position
        });
      }

      return next();
    });
  }
});
