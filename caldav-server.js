/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

const { randomUUID } = require('node:crypto');

const API = require('@ladjs/api');
const Boom = require('@hapi/boom');
const ICAL = require('ical.js');
const Lock = require('ioredfour');
const caldavAdapter = require('caldav-adapter');
const etag = require('etag');
const mongoose = require('mongoose');
const { rrulestr } = require('rrule');

const CalendarEvents = require('#models/calendar-events');
const Calendars = require('#models/calendars');
const config = require('#config');
const createTangerine = require('#helpers/create-tangerine');
const i18n = require('#helpers/i18n');
const logger = require('#helpers/logger');
const onAuth = require('#helpers/on-auth');
const refreshSession = require('#helpers/refresh-session');
const { acquireLock, releaseLock } = require('#helpers/lock');

// TODO: DNS SRV records <https://sabre.io/dav/service-discovery/#dns-srv-records>

async function onAuthPromise(auth, session) {
  return new Promise((resolve, reject) => {
    onAuth.call(this, auth, session, (err, user) => {
      if (err) return reject(err);
      resolve(user);
    });
  });
}

function bumpSyncToken(synctoken) {
  const parts = synctoken.split('/');
  return (
    parts.slice(0, -1).join('/') +
    '/' +
    (Number.parseInt(parts[parts.length - 1], 10) + 1)
  );
}

// TODO: support SMS reminders for VALARM

//
// TODO: we should fork ical.js and merge these PR's
//       <https://github.com/kewisch/ical.js/issues/646>
//

//
// TODO: valarm duration needs to be converted to a Number or (date/string?)
//
// const dt = ICAL.Time.fromJSDate(new Date('2024-01-01T06:00:00.000Z'))
// const cp = dt.clone()
// cp.addDuration(ICAL.Duration.fromString('-P0DT0H30M0S'));
// cp.toJSDate()

/*
    const event = ctx.request.ical.find((obj) => obj.type === 'VEVENT');
    if (!event) return;

    // safeguard in case our implementation is off (?)
    if (ctx.request.ical.filter((obj) => obj.type === 'VEVENT').length > 1) {
      const err = new TypeError('Multiple VEVENT passed');
      err.ical = ctx.request.ical;
      throw err;
    }

    // safeguard in case library isn't working for some reason
    const parsed = ICAL.parse(ctx.request.body);
    if (!parsed || parsed.length === 0) {
      const err = new TypeError('ICAL.parse was not successful');
      err.parsed = parsed;
      throw err;
    }

    const comp = new ICAL.Component(parsed);
    if (!comp) throw new TypeError('ICAL.Component was not successful');

    const vevent = comp.getFirstSubcomponent('vevent');

    if (!vevent)
      throw new TypeError('comp.getFirstSubcomponent was not successful');

    const icalEvent = new ICAL.Event(vevent);

    if (!icalEvent) throw new TypeError('ICAL.Event was not successful');

    //
    // VALARM
    //
    const icalAlarms = icalEvent.component.getAllSubcomponents('valarm');
    event.alarms = [];
    for (const alarm of icalAlarms) {
      // getFirstProperty('x').getParameter('y')
      // NOTE: attendee missing from ical-generator right now
      //       (which is who the alarm correlates to, e.g. `ATTENDEE:mailto:foo@domain.com`)
      // <https://github.com/sebbo2002/ical-generator/issues/573>
      /*
  alarms.push({
    // DISPLAY (to lower case for ical-generator)
    type: 'DISPLAY', 'AUDIO', 'EMAIL' (required)
    trigger: Number or Date,
    relatesTo: 'END', 'START', or null
    repeat: {
      times: Number,
      interval: Number
    } || null,
    attach: {
      uri: String,
      mime: String || null
    } || null,
    description: String || null,
    x: [
      { key: '', value: '' }
    ]
  });
  */

/*
      let trigger;
      let relatesTo = null;
      if (alarm.getFirstProperty('trigger')) {
        const value = alarm.getFirstPropertyValue('trigger');
        if (value instanceof ICAL.Duration) {
          trigger = value.toSeconds();
        } else if (value instanceof ICAL.Time) {
          trigger = value.toJSDate();
        }

        if (alarm.getFirstProperty('trigger').getParameter('related'))
          relatesTo = alarm.getFirstProperty('trigger').getParameter('related');
      }

      let repeat = null;
      // RFC spec requires that both are set if one of them is
      if (
        alarm.getFirstProperty('repeat') &&
        alarm.getFirstProperty('duration')
      ) {
        const value = alarm.getFirstPropertyValue('duration');
        repeat = {
          times: alarm.getFirstPropertyValue('repeat'), // ical.js already parses as a number
          interval: value.toSeconds()
        };
      }

      //
      // NOTE: attachments are not added right now because ical-generator does not support them properly
      //
      // TODO: ical-generator is missing some required props used for reconstructing attachments
      //       <https://github.com/sebbo2002/ical-generator/issues/577>
      //
      // TODO: ical-generator toString() is completely broken for attachments right now
      //       <https://github.com/sebbo2002/ical-generator/blob/f27dd10e9b2d830953687eca5daa52acca1731cc/src/alarm.ts#L618-L627>
      //       (e.g. it doesn't support the value below)
      //
      // TODO: we should probably drop ical-generator and rewrite it with ical.js purely
      //
      const attach = null;
      // ATTACH;FMTTYPE=text/plain;ENCODING=BASE64;VALUE=BINARY;X-BASE64-PARAM=UGFyYW1ldGVyCg=:WW91IHJlYWxseSBzcGVudCB0aGUgdGltZSB0byBiYXNlNjQgZGVjb2RlIHRoaXM/Cg=
      event.alarms.push({
        type: alarm.getFirstPropertyValue('action'),
        trigger,
        relatesTo,
        repeat,
        attach // TODO: fix this in the future
      });
    }

    //
    // ATTENDEE
    //
    const icalAttendees = icalEvent.attendees;
    event.attendees = [];
    for (const attendee of icalAttendees) {
      //
      // NOTE: there is a bug right now with node-ical parser for attendees
      //       (only one attendee is parsed even if there are multiple)
      //       <https://github.com/jens-maus/node-ical/issues/302>
      //
      // TODO: validate attendee props in the future
      //       <https://github.com/sebbo2002/ical-generator/blob/c6d2f1f9909930743acb54003e124faea4f58cec/src/attendee.ts#L38-L74>
      //
      // <https://github.com/sebbo2002/ical-generator/blob/9190c842f4e9aa9ac8fd598983303cb95e3cf76b/src/attendee.ts#L22>
      //
      // name?: string | null;
      // email: string;
      // mailto?: string | null;
      // sentBy?: string | null;
      // status?: ICalAttendeeStatus | null;
      // role?: ICalAttendeeRole;
      // rsvp?: boolean | null;
      // type?: ICalAttendeeType | null;
      // delegatedTo?: ICalAttendee | ICalAttendeeData | string | null;
      // delegatedFrom?: ICalAttendee | ICalAttendeeData | string | null;
      // x?: {key: string, value: string}[] | [string, string][] | Record<string, string>;
      //
      const x = [];
      for (const key of Object.keys(attendee.jCal[1])) {
        if (key.startsWith('x-')) {
          x.push({
            key,
            value: attendee.jCal[1][key]
          });
        }
      }

      event.attendees.push({
        name: attendee.getParameter('cn'),
        email: attendee.getParameter('email').replace('mailto:', ''), // safeguard (?)
        mailto: attendee.getFirstValue().replace('mailto:', ''),
        sentBy: attendee.getParameter('sent-by') || null,
        status: attendee.getParameter('partstat'),
        role: attendee.getParameter('role') || null,
        rsvp: attendee.getParameter('rsvp')
          ? boolean(attendee.getParameter('rsvp'))
          : null,
        type: attendee.getParameter('cutype'),
        delegatedTo: attendee.getParameter('delegated-to'),
        delegatedFrom: attendee.getParameter('delegated-from'),
        x
      });
    }

    //
    // summary is always a string
    // (safeguard fallback in case node-ical doesn't parse it properly as a string)
    //
    event.summary =
      typeof event.summary === 'string' ? event.summary : icalEvent.summary;

    // add X- arbitrary attributes
    const x = [];
    for (const key of Object.keys(icalEvent.jCal[1])) {
      if (
        key.startsWith('x-') && //
        // NOTE: these props get auto-added by toString() of an Event in ical-generator
        //       (so we want to ignore them here so they won't get added twice to ICS output)
        //
        // X-MICROSOFT-CDO-ALLDAYEVENT
        // X-MICROSOFT-MSNCALENDAR-ALLDAYEVENT
        // X-APPLE-STRUCTURED-LOCATION
        // X-ALT-DESC
        // X-MICROSOFT-CDO-BUSYSTATUS
        ![
          'x-microsoft-cdo-alldayevent',
          'x-microsoft-msncalendar-alldayevent',
          'x-apple-structured-location',
          'x-alt-desc',
          'x-microsoft-cdo-busystatus'
        ].includes(key)
      ) {
        x.push({
          key,
          value: icalEvent.jCal[1][key]
        });
      }
    }

    // location is an object and consists of
    // - title (string)
    // - address (string)
    // - radius (number) - which is from `X-APPLE-RADIUS`
    // - geo (object - `{ lat: Num, lon: Num }`)
    // or it's a string or null
    if (typeof event.location === 'object' && event.location !== null) {
      if (_.isEmpty(event.location)) {
        if (event.geo) {
          // NOTE: pending this issue being resolved, this would actually start working
          //       <https://github.com/sebbo2002/ical-generator/issues/569>
          event.location = {
            title: undefined,
            address: undefined,
            radius: undefined,
            geo: event.geo
          };
        } else {
          event.location = undefined;
        }
      } else {
        //
        // NOTE: this ical-generator implementation is mainly geared to support Apple location
        //
        //       X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS=Kurfürstendamm 26\, 10719
        //         Berlin\, Deutschland;X-APPLE-RADIUS=141.1751386318387;X-TITLE=Apple Store
        //         Kurfürstendamm:geo:52.50363,13.32865
        //
        //       <https://github.com/search?q=repo%3Asebbo2002%2Fical-generator+Apple+Store+Kurf%C3%BCrstendamm&type=code>
        if (
          typeof event['APPLE-STRUCTURED-LOCATION'] === 'object' &&
          !_.isEmpty(event['APPLE-STRUCTURED-LOCATION'])
        ) {
          // "APPLE-STRUCTURED-LOCATION": {
          //   "params": {
          //     "VALUE": "URI",
          //     "X-ADDRESS": "Kurfürstendamm 26\\, 10719 Berlin\\, Deutschland",
          //     "X-APPLE-RADIUS": 141.1751386318387,
          //     "X-TITLE": "Apple Store Kurfürstendamm"
          //   },
          //   "val": "geo:52.50363,13.32865"
          // },
          event.location = {
            title: event['APPLE-STRUCTURED-LOCATION'].params['X-TITLE'],
            address: event['APPLE-STRUCTURED-LOCATION'].params['X-ADDRESS'],
            radius: event['APPLE-STRUCTURED-LOCATION'].params['X-APPLE-RADIUS'],
            geo: event.geo || undefined
          };
        } else {
          event.location = {
            title: event.location.val,
            address: undefined,
            radius: undefined,
            geo: event.geo || undefined
          };
        }
      }
    } else if (typeof event.location === 'string') {
      event.location = {
        title: event.location,
        address: undefined,
        radius: undefined,
        geo: event.geo || undefined
      };
    } else if (event.geo) {
      // NOTE: pending this issue being resolved, this would actually start working
      //       <https://github.com/sebbo2002/ical-generator/issues/569>
      event.location = {
        title: undefined,
        address: undefined,
        radius: undefined,
        geo: event.geo
      };
    } else {
      event.location = undefined;
    }

    //
    // TODO: add STYLED-DESCRIPTION to buildICS output
    // TODO: add ALTREP to buildICS object (thunderbird support)
    //
    // description is either an object, string, or null/undefined
    if (typeof event.description === 'object' && event.description !== null) {
      if (_.isEmpty(event.description)) {
        event.description = undefined;
      } else {
        // TODO: support thunderbird altrep
        event.description = {
          plain,
          html
        };
      }
    }

    //
    // TODO: use ICAL parsed organizer here
    //
    // https://github.com/jens-maus/node-ical/issues/303
    // organizer is either an object, string or null
    // if it's an object it has these props:
    //
    // - name: string;
    // - email?: string;
    // - mailto?: string;
    // - sentBy?: string;
    //
    // NOTE: there is a core bug in node-ical where it does not parse organizer properly
    //       https://github.com/jens-maus/node-ical/issues/303
    //
    //  ORGANIZER:mailto:cyrus@example.com
    //  (just a string)
    //
    // or
    //
    // ORGANIZER;CN="Bernard Desruisseaux":mailto:bernard@example.com
    //
    // <https://github.com/sebbo2002/ical-generator/blob/9190c842f4e9aa9ac8fd598983303cb95e3cf76b/src/event.ts#L1786C1-L1800C10>
    // if (this.data.organizer) {
    //     g += 'ORGANIZER;CN="' + escape(this.data.organizer.name, true) + '"';
    //     if (this.data.organizer.sentBy) {
    //         g += ';SENT-BY="mailto:' + escape(this.data.organizer.sentBy, true) + '"';
    //     }
    //     if (this.data.organizer.email && this.data.organizer.mailto) {
    //         g += ';EMAIL=' + escape(this.data.organizer.email, false);
    //     }
    //     if(this.data.organizer.email) {
    //         g += ':mailto:' + escape(this.data.organizer.mailto || this.data.organizer.email, false);
    //     }
    //     g += '\r\n';
    // }
    //
    // NOTE: the output is weird in toString() right now because of how the author designed this
    //       <https://github.com/sebbo2002/ical-generator/issues/571>
    //
    if (typeof event.organizer === 'object' && event.organizer !== null) {
      const mailto = isEmail(event.organizer.val)
        ? event.organizer.val
        : event.organizer.val.replace('mailto:', '');
      event.organizer = {
        name: event.organizer.params.CN,
        email: event.organizer.params.EMAIL
          ? event.organizer.params.EMAIL.replace('mailto:', '')
          : undefined,
        mailto,
        sentBy: event.organizer.params['SENT-BY']
          ? event.organizer.params['SENT-BY'].replace('mailto:', '')
          : undefined
      };
    }

    //
    // NOTE: services like cal.com have some pretty huge issues with calendar support
    //       <https://github.com/calcom/cal.com/issues/3457>
    //       <https://github.com/calcom/cal.com/issues/9485>
    //

    let description;

    // TODO: location and contact can have ALTREP too

    // TODO: convert this to html/plain and change the DB model too

    // TODO: we need to use `unescape()` on the HTML parsed value
    //       because when `toString()` is called by ical-generator
    //       it will automatically use `escape` on the values

    // NOTE: Thunderbird sends over description with:
    // `DESCRIPTION;ALTREP="data:text/html,yaya%3Cb%3Eyay%3C%2Fb%3Eay":yayayayay`

    // TODO: organizer is similar to attendee
  */

//
// CalDAV
// <https://www.rfc-editor.org/rfc/rfc4791>
//
class CalDAV extends API {
  constructor(options = {}, Users) {
    super(options, Users);

    this.logger = logger;
    this.resolver = createTangerine(this.client, logger);

    this.wsp = options.wsp;

    this.lock = new Lock({
      redis: this.client,
      namespace: config.imapLockNamespace
    });

    this.authenticate = this.authenticate.bind(this);
    this.createCalendar = this.createCalendar.bind(this);
    this.getCalendar = this.getCalendar.bind(this);
    this.updateCalendar = this.updateCalendar.bind(this);
    this.getCalendarsForPrincipal = this.getCalendarsForPrincipal.bind(this);
    this.getEventsForCalendar = this.getEventsForCalendar.bind(this);
    this.getEventsByDate = this.getEventsByDate.bind(this);
    this.getEvent = this.getEvent.bind(this);
    this.createEvent = this.createEvent.bind(this);
    this.updateEvent = this.updateEvent.bind(this);
    this.deleteEvent = this.deleteEvent.bind(this);
    this.buildICS = this.buildICS.bind(this);
    this.getCalendarId = this.getCalendarId.bind(this);
    this.getETag = this.getETag.bind(this);

    this.app.use(
      caldavAdapter({
        authenticate: this.authenticate,
        authRealm: 'forwardemail/caldav',
        caldavRoot: '/',
        calendarRoot: 'dav',
        principalRoot: 'principals',
        // <https://github.com/sedenardi/node-caldav-adapter/blob/bdfbe17931bf14a1803da77dbb70509db9332695/src/koa.ts#L130-L131>
        disableWellKnown: false,
        logEnabled: config.env !== 'production',
        logLevel: 'debug',
        data: {
          createCalendar: this.createCalendar,
          updateCalendar: this.updateCalendar,
          getCalendar: this.getCalendar,
          getCalendarsForPrincipal: this.getCalendarsForPrincipal,
          getEventsForCalendar: this.getEventsForCalendar,
          getEventsByDate: this.getEventsByDate,
          getEvent: this.getEvent,
          createEvent: this.createEvent,
          updateEvent: this.updateEvent,
          deleteEvent: this.deleteEvent,
          buildICS: this.buildICS,
          getCalendarId: this.getCalendarId,
          getETag: this.getETag
        }
      })
    );
  }

  async authenticate(ctx, { username, password, principalId }) {
    logger.debug('authenticate', { username, password, principalId });

    ctx.state.session = {
      id: ctx.req.id,
      remoteAddress: ctx.ip,
      request: ctx.request
    };

    try {
      const { user } = await onAuthPromise.call(
        this,
        // auth
        {
          username,
          password
        },
        // session
        ctx.state.session
      );

      // caldav related user properties
      user.principalId = user.username;
      user.principalName = user.username; // .toUpperCase()

      // set user in session and state
      ctx.state.user = user;
      ctx.state.session.user = user;

      // set locale for translation in ctx
      ctx.isAuthenticated = () => true;
      ctx.request.acceptsLanguages = () => false;
      await i18n.middleware(ctx, () => Promise.resolve());

      // connect to db
      await refreshSession.call(this, ctx.state.session, 'CALDAV');

      // ensure that the default calendar exists
      const defaultCalendar = await this.getCalendar(ctx, {
        calendarId: user.username,
        principalId: user.username,
        user
      });

      logger.debug('defaultCalendar', { defaultCalendar });

      return user;
    } catch (err) {
      logger.error(err);
      throw Boom.unauthorized(err);
    }
  }

  async createCalendar(ctx, { name, description, timezone }) {
    logger.debug('createCalendar', {
      name,
      description,
      timezone,
      params: ctx.state.params
    });
    name = name || ctx.state.params.calendarId || randomUUID();
    const calendarId = ctx.state.params.calendarId || name;
    return Calendars.create({
      // db virtual helper
      instance: this,
      session: ctx.state.session,

      // calendarId
      calendarId,

      // calendar obj
      name,
      description,
      prodId: `//forwardemail.net//caldav//${ctx.locale.toUpperCase()}`,
      timezone: timezone || ctx.state.session.user.timezone,
      url: config.urls.web,
      readonly: false,
      synctoken: `${config.urls.web}/ns/sync-token/1`
    });
  }

  // https://caldav.forwardemail.net/dav/support@forwardemail.net/default
  async getCalendar(ctx, { calendarId, principalId, user }) {
    logger.debug('getCalendar', { calendarId, principalId, user });

    let calendar;
    if (mongoose.isObjectIdOrHexString(calendarId))
      calendar = await Calendars.findOne(this, ctx.state.session, {
        _id: new mongoose.Types.ObjectId(calendarId)
      });
    if (!calendar)
      calendar = await Calendars.findOne(this, ctx.state.session, {
        calendarId
      });
    if (!calendar)
      calendar = await Calendars.create({
        // db virtual helper
        instance: this,
        session: ctx.state.session,

        // calendarId
        calendarId,

        // calendar obj
        // NOTE: Android uses "Events" and most others use "Calendar" as default calendar name
        name: ctx.translate('CALENDAR'),
        description: config.urls.web,
        prodId: `//forwardemail.net//caldav//${ctx.locale.toUpperCase()}`,
        //
        // NOTE: instead of using timezone from IP we use
        //       their last time zone set in a browser session
        //       (this is way more accurate and faster)
        //
        //       here were some alternatives though during R&D:
        //       * <https://github.com/runk/node-maxmind>
        //       * <https://github.com/evansiroky/node-geo-tz>
        //       * <https://github.com/safing/mmdbmeld>
        //       * <https://github.com/sapics/ip-location-db>
        //
        timezone: ctx.state.session.user.timezone,
        url: config.urls.web,
        readonly: false,
        synctoken: `${config.urls.web}/ns/sync-token/1`
      });

    logger.debug('getCalendar result', { calendar });

    return calendar;
  }

  //
  // NOTE: we have added updateCalendar support
  // <https://github.com/sedenardi/node-caldav-adapter/blob/bdfbe17931bf14a1803da77dbb70509db9332695/example/server.js#L33>
  // <https://github.com/sedenardi/node-caldav-adapter/blob/bdfbe17931bf14a1803da77dbb70509db9332695/example/data.js#L111-L120>
  //
  async updateCalendar(ctx, { principalId, calendarId, user }) {
    logger.debug('updateCalendar', { principalId, calendarId, user });
    //
    // 1) acquire a lock
    // 2) parse `ctx.request.body` for VCALENDAR and all VEVENT's
    // 3) update the calendar metadata based off VCALENDAR
    // 4) delete existing VEVENTS
    // 5) create new VEVENTS
    // 6) release lock
    //
    let lock;
    let err;
    try {
      // parse `ctx.request.body` for VCALENDAR and all VEVENT's
      const comp = new ICAL.Component(ICAL.parse(ctx.request.body));
      if (!comp) throw new TypeError('Component not parsed');

      const vevents = comp.getAllSubcomponents('vevent');
      logger.debug('vevents', { vevents });

      // update the calendar metadata based off VCALENDAR
      const x = [];
      for (const prop of comp.getAllProperties()) {
        // <https://github.com/kewisch/ical.js/blob/main/lib/ical/property.js>
        // prop.name = "x-wr-calname"
        // X-WR-CALNAME:Calendar
        // if character after name is ":" then +1 otherwise include it
        // (or could we just do `getValues()` and it would set it properly?)
        // prop.toICALString()
        if (!prop.name.startsWith('x-')) continue;
        x.push({
          key: prop.name.toUpperCase(),
          value: prop.getValues()
        });
      }

      let calendar = await this.getCalendar(ctx, {
        calendarId,
        principalId,
        user
      });

      // acquire a lock
      lock = await acquireLock(this, {
        wsp: true,
        id: user.alias_id
      });

      const update = {
        name: comp.getFirstPropertyValue('name'),
        prodId: comp.getFirstPropertyValue('prodid'),

        // TODO: it could be HTML so this should be fixed
        description: comp.getFirstPropertyValue('description'),
        // TODO: timezone
        source: comp.getFirstPropertyValue('source'),
        url: comp.getFirstPropertyValue('url'),
        scale: comp.getFirstPropertyValue('calscale'),
        // TODO: refresh-interval -> calendar.ttl
        // NOTE: these are not being set yet
        // categories
        // refresh-interval -> calendar.ttl
        // color
        // image
        // conference
        x,
        // TODO: this should probably only happen if the create was successful
        synctoken: bumpSyncToken(calendar.synctoken)
      };

      calendar = await Calendars.findByIdAndUpdate(
        this,
        ctx.state.session,
        calendar._id,
        {
          $set: update
        },
        {
          lock
        }
      );

      //
      // NOTE: this isn't the safest way to do this (instead should only conditionally delete and update)
      //

      // delete existing VEVENTS
      const deleted = await CalendarEvents.deleteMany(
        this,
        ctx.state.session,
        {
          calendar: calendar._id
        },
        {
          lock
        }
      );

      // create new VEVENTS
      if (vevents.length > 0) {
        const events = [];

        // we group together events by UID and build a new ICS for each
        const eventIdToEvents = {};

        // a bit of a hack but it will get us the ical string and then rebuild it together with other occurences
        for (const vevent of vevents) {
          const eventId = vevent.getFirstPropertyValue('uid');
          if (!Array.isArray(eventIdToEvents[eventId]))
            eventIdToEvents[eventId] = [];
          const vc = new ICAL.Component(['vcalendar', [], []]);
          vc.addSubcomponent(vevent);
          eventIdToEvents[eventId].push({
            eventId,
            calendar: calendar._id,
            ical: vc.toString()
          });
        }

        for (const eventId of Object.keys(eventIdToEvents)) {
          // eslint-disable-next-line no-await-in-loop
          const ical = await this.buildICS(
            ctx,
            eventIdToEvents[eventId],
            calendar
          );
          events.push({
            // db virtual helper
            instance: this,
            session: ctx.state.session,
            lock,

            // event obj
            eventId,
            calendar: calendar._id,
            ical
          });
        }

        const createdEvents = await CalendarEvents.create(
          this,
          ctx.state.session,
          events
        );
      }

      return calendar;
    } catch (_err) {
      err = _err;
    }

    // release lock
    if (lock?.success) {
      try {
        await releaseLock(
          this,
          {
            wsp: true,
            id: user.alias_id
          },
          lock
        );
      } catch (err) {
        logger.fatal(err, { principalId, calendarId });
      }
    }

    // throw error if any
    if (err) throw err;
  }

  // https://caldav.forwardemail.net/dav/support@forwardemail.net <--- both of these would do the same
  // https://caldav.forwardemail.net/dav/calendars <--- both of these would do the same
  // NOTE: in the future we could do readonly and sharing here with auth permissioning system
  async getCalendarsForPrincipal(ctx, { principalId, user }) {
    logger.debug('getCalendarsForPrincipal', { principalId, user });
    return Calendars.find(this, ctx.state.session, {});
  }

  async getEventsForCalendar(ctx, { calendarId, principalId, user, fullData }) {
    logger.debug('getEventsForCalendar', {
      calendarId,
      principalId,
      user,
      fullData
    });

    const calendar = await this.getCalendar(ctx, {
      calendarId,
      principalId,
      user
    });

    return CalendarEvents.find(this, ctx.state.session, {
      calendar: calendar._id
    });
  }

  // eslint-disable-next-line complexity
  async getEventsByDate(
    ctx,
    { calendarId, start, end, principalId, user, fullData }
  ) {
    logger.debug('getEventsByDate', {
      calendarId,
      start,
      end,
      principalId,
      user,
      fullData
    });

    const calendar = await this.getCalendar(ctx, {
      calendarId,
      principalId,
      user
    });

    // TODO: incorporate database date query instead of this in-memory filtering
    // TODO: we could do partial query for not recurring and b/w and then has recurring and after
    const events = await CalendarEvents.find(this, ctx.state.session, {
      calendar: calendar._id
    });

    const filtered = [];

    //
    // NOTE: an event can have multiple RRULE, RDATE, EXDATE values
    //
    for (const event of events) {
      const comp = new ICAL.Component(ICAL.parse(event.ical));
      const vevents = comp.getAllSubcomponents('vevent');
      if (vevents.length === 0) {
        const err = new TypeError('Event missing VEVENT');
        logger.error(err, { event, calendar });
        continue;
      }

      let match = false;
      for (const vevent of vevents) {
        const lines = [];
        // start = dtstart
        // end = dtend
        let dtstart = vevent.getFirstPropertyValue('dtstart');
        if (!dtstart || !(dtstart instanceof ICAL.Time)) {
          const err = new TypeError('DTSTART missing on event');
          logger.error(err, { event, calendar });
          continue;
        }

        dtstart = dtstart.toJSDate();

        let dtend = vevent.getFirstPropertyValue('dtend');
        dtend = dtend && dtend instanceof ICAL.Time ? dtend.toJSDate() : null;

        for (const key of ['rrule', 'exrule', 'exdate', 'rdate']) {
          const properties = vevent.getAllProperties(key);
          for (const prop of properties) {
            lines.push(prop.toICALString());
          }
        }

        if (lines.length === 0) {
          if (
            (!start || (dtend && start <= dtend)) &&
            (!end || (dtstart && end >= dtstart))
          ) {
            match = true;
            break;
          }

          continue;
        }

        const rruleSet = rrulestr(lines.join('\n'));

        // check queried date range (if both start and end specified)
        if (start && end) {
          const dates = rruleSet.between(start, end, true);
          if (dates.length > 0) {
            match = true;
            break;
          }

          continue;
        }

        // if only start specified
        if (start) {
          const date = rruleSet.after(start, true);
          if (date) {
            match = true;
            break;
          }

          continue;
        }

        // if only end specified
        if (end) {
          const date = rruleSet.before(end, true);
          if (date) {
            match = true;
            break;
          }
        }
      }

      if (match) filtered.push(event);
    }

    return filtered;
  }

  async getEvent(ctx, { eventId, principalId, calendarId, user, fullData }) {
    logger.debug('getEvent', {
      eventId,
      principalId,
      calendarId,
      user,
      fullData
    });

    const calendar = await this.getCalendar(ctx, {
      calendarId,
      principalId,
      user
    });

    const event = await CalendarEvents.findOne(this, ctx.state.session, {
      eventId,
      calendar: calendar._id
    });

    return event;
  }

  // eventId: ctx.state.params.eventId,
  // principalId: ctx.state.params.principalId,
  // calendarId: ctx.state.params.calendarId,
  // user: ctx.state.user
  // NOTE: `ical` String is also ctx.request.body in this method
  async createEvent(ctx, { eventId, principalId, calendarId, user }) {
    logger.debug('createEvent', {
      eventId,
      principalId,
      calendarId,
      user
    });

    const calendar = await this.getCalendar(ctx, {
      calendarId,
      principalId,
      user
    });

    // check if there is an event with same calendar ID already
    const exists = await CalendarEvents.findOne(this, ctx.state.session, {
      eventId,
      calendar: calendar._id
    });

    if (exists)
      throw Boom.badRequest(ctx.translateError('EVENT_ALREADY_EXISTS'));

    // TODO: this should probably only happen if the create was successful
    await Calendars.findByIdAndUpdate(this, ctx.state.session, calendar._id, {
      $set: {
        synctoken: bumpSyncToken(calendar.synctoken)
      }
    });

    const calendarEvent = {
      // db virtual helper
      instance: this,
      session: ctx.state.session,

      // event obj
      eventId,
      calendar: calendar._id,
      ical: ctx.request.body
    };

    //
    // TODO: if user logs into CalDAV and does not have SMTP enabled and verified
    //       then send the user an email and notify them that calendar invites
    //       will not get automatically emailed until they set this up properly
    //       at https://forwardemail.net/my-account/domains/yourdomain.com/verify-smtp
    //

    // NOTE: here is Thunderbird's implementation of itip
    //       <https://github.com/mozilla/releases-comm-central/blob/0b146e856d83fc7189a6e79800871916fc00e725/calendar/base/modules/utils/calItipUtils.sys.mjs#L31>

    // TODO: ensure we have support for all these RFC's down the road
    //       <https://stackoverflow.com/a/36344164>
    //       <https://github.com/nextcloud/calendar/wiki/Developer-Resources#rfcs>

    //
    // TODO: actually send invites via email and attach ics file
    //       <https://datatracker.ietf.org/doc/html/rfc6047#section-2.5>
    //       <https://sabre.io/dav/scheduling/>
    //       <https://datatracker.ietf.org/doc/html/rfc6047>
    //
    // X-MOZ-SEND-INVITATIONS:TRUE
    // X-MOZ-SEND-INVITATIONS-UNDISCLOSED:FALSE
    //
    // if SCHEDULE-AGENT=CLIENT then do not send invite
    //
    // From: user1@example.com
    // To: user2@example.com
    // Subject: Phone Conference
    // Mime-Version: 1.0
    // Date: Wed, 07 May 2008 21:30:25 +0400
    // Message-ID: <4821E731.5040506@laptop1.example.com>
    // Content-Type: text/calendar; method=REQUEST; charset=UTF-8
    // Content-Transfer-Encoding: quoted-printable
    //
    // BEGIN:VCALENDAR
    // PRODID:-//Example/ExampleCalendarClient//EN
    // METHOD:REQUEST
    // VERSION:2.0
    // BEGIN:VEVENT
    // ORGANIZER:mailto:user1@example.com
    // ATTENDEE;ROLE=CHAIR;PARTSTAT=ACCEPTED:mailto:user1@example.com
    // ATTENDEE;RSVP=YES;CUTYPE=INDIVIDUAL:mailto:user2@example.com
    // DTSTAMP:20080507T170000Z
    // DTSTART:20080701T160000Z
    // DTEND:20080701T163000Z
    // SUMMARY:Phone call to discuss your last visit
    // DESCRIPTION:=D1=82=D1=8B =D0=BA=D0=B0=D0=BA - =D0=B4=D0=BE=D0=
    //  =B2=D0=BE=D0=BB=D0=B5=D0=BD =D0=BF=D0=BE=D0=B5=D0=B7=D0=B4=D0=BA=D0
    //  =BE=D0=B9?
    // UID:calsvr.example.com-8739701987387998
    // SEQUENCE:0
    // STATUS:TENTATIVE
    // END:VEVENT
    // END:VCALENDAR
    //

    //
    // NOTE: see this thread from nextcloud regarding description
    //       and the issues (and cleanup necessary) that was done to support Thunderbird and other clients
    //
    //       <https://github.com/nextcloud/calendar/issues/3863>
    //       <https://github.com/nextcloud/tasks/issues/2239>
    //       <https://github.com/nextcloud/calendar/pull/3924>
    //       <https://github.com/nextcloud/tasks/pull/2240/commits/cb87ab1b5ca3abdfa012e26fbe85827275f4cb66>
    //       <https://github.com/nextcloud/calendar/issues/3234>
    //       <https://github.com/nextcloud/server/pull/41370>
    //

    logger.debug('create calendar event', { calendarEvent });

    return CalendarEvents.create(calendarEvent);
  }

  // NOTE: `ical` String is also ctx.request.body in this method
  async updateEvent(ctx, { eventId, principalId, calendarId, user }) {
    logger.debug('updateEvent', {
      eventId,
      principalId,
      calendarId,
      user
    });

    const calendar = await this.getCalendar(ctx, {
      calendarId,
      principalId,
      user
    });

    let e = await CalendarEvents.findOne(this, ctx.state.session, {
      eventId,
      calendar: calendar._id
    });

    if (!e) throw Boom.badRequest(ctx.translateError('EVENT_DOES_NOT_EXIST'));

    // TODO: this should probably only happen if the save was successful
    await Calendars.findByIdAndUpdate(this, ctx.state.session, calendar._id, {
      $set: {
        synctoken: bumpSyncToken(calendar.synctoken)
      }
    });

    // db virtual helper
    e.instance = this;
    e.session = ctx.state.session;

    // so we can call `save()`
    e.isNew = false;

    // TODO: is this not updating?
    // console.log('UPDATING BODY', ctx.request.body);

    e.ical = ctx.request.body;

    // save event
    e = await e.save();

    return e;
  }

  async deleteEvent(ctx, { eventId, principalId, calendarId, user }) {
    logger.debug('deleteEvent', { eventId, principalId, calendarId, user });

    const calendar = await this.getCalendar(ctx, {
      calendarId,
      principalId,
      user
    });

    const event = await CalendarEvents.findOne(this, ctx.state.session, {
      eventId,
      calendar: calendar._id
    });

    if (event) {
      // TODO: this should probably only happen if the delete was successful
      await Calendars.findByIdAndUpdate(this, ctx.state.session, calendar._id, {
        $set: {
          synctoken: bumpSyncToken(calendar.synctoken)
        }
      });

      await CalendarEvents.deleteOne(this, ctx.state.session, {
        _id: event._id
      });
    }

    return event;
  }

  //
  // NOTE: originally we used ical-generator to rebuild the ICS file
  //       however it wasn't in conformity with the RFC specification
  //       and after finding numerous issues we decided to simply re-use the existing ICS file
  //
  async buildICS(ctx, events, calendar) {
    logger.debug('buildICS', { events, calendar });
    if (!events || Array.isArray(events)) {
      // <https://github.com/kewisch/ical.js/wiki/Creating-basic-iCalendar>
      const comp = new ICAL.Component(['vcalendar', [], []]);

      comp.updatePropertyWithValue('version', '2.0');

      //
      // NOTE: these are required fields
      //

      // uid -> calendar.calendarId
      comp.updatePropertyWithValue('uid', calendar.calendarId);

      // name -> calendar.name
      comp.updatePropertyWithValue('name', calendar.name);

      // NOTE: we don't set `calendar.timezone` here since we don't need VTIMEZONE in VCALENDAR
      // <https://github.com/kewisch/ical.js/blob/3754b8332802bca0163dcaa432fa34c2ce487772/samples/daily_recur.ics#L6-L24>
      // - X-WR-CALNAME:Calendar
      // - X-WR-TIMEZONE:America/Chicago

      // prodid
      if (calendar.prodId)
        comp.updatePropertyWithValue('prodid', calendar.prodId);

      // description
      if (calendar.description)
        comp.updatePropertyWithValue('description', calendar.description);

      // created -> calendar.created_at
      // comp.updatePropertyWithValue(
      //   'created',
      //   ICAL.Time.fromJSDate(calendar.created_at, true)
      // );

      // last-modified -> calendar.updated_at
      // comp.updatePropertyWithValue(
      //   'last-modified',
      //   ICAL.Time.fromJSDate(calendar.updated_at, true)
      // );

      // calscale -> calendar.scale
      if (calendar.scale)
        comp.updatePropertyWithValue('calscale', calendar.scale);

      // url
      if (calendar.url) comp.updatePropertyWithValue('url', calendar.url);

      // source
      if (calendar.source)
        comp.updatePropertyWithValue('source', calendar.source);

      // NOTE: these are not being set yet
      // categories
      // refresh-interval -> calendar.ttl
      // color
      // image
      // conference

      // X-Meta-Data
      if (Array.isArray(calendar.x) && calendar.x.length > 0) {
        for (const xData of calendar.x) {
          comp.updatePropertyWithValue(xData.key.toUpperCase(), xData.value);
        }
      }

      // add all VEVENTS
      for (const event of events) {
        const eventComp = new ICAL.Component(ICAL.parse(event.ical));
        const vevents = eventComp.getAllSubcomponents('vevent');
        for (const vevent of vevents) {
          //
          // NOTE: until this issue is resolved we have to manually remove these lines
          //       <https://github.com/mozilla/releases-comm-central/issues/94>
          //
          vevent.removeAllProperties('X-MOZ-LASTACK');
          vevent.removeAllProperties('X-MOZ-GENERATION');

          // add to main calendar
          comp.addSubcomponent(vevent);
        }
      }

      return comp.toString();
    }

    // events = single event if not an Array
    return events.ical;
  }

  getCalendarId(ctx, calendar) {
    return calendar._id.toString();
  }

  getETag(ctx, event) {
    return etag(event.updated_at.toISOString());
  }
}

module.exports = CalDAV;
