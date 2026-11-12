// The event allow-list. One source of truth for the ingest function; a copy lives in assets/js/bb-analytics.js
// and .github/tests/analytics.test.mjs fails if the two differ. Every prop is a short code (an enum or a small
// pattern), never free text. To add an event or a prop, change both copies and add a test.
export const SCHEMA = {
  // OMG is not here on purpose (its own counter has no device ID). STT keeps its own table on its own project.
  apps: ['hub', 'ruffspeak', 'chess', 'ridgeline', 'bbsite'],
  platforms: ['web', 'ios', 'android'],
  surface: { re: '^[a-z][a-z0-9_-]{0,31}$' },
  events: {
    app_open: { props: { surface: { re: '^[a-z][a-z0-9_-]{0,31}$' }, auth_state: { enum: ['guest', 'member'] } } },
    guest_continue: { props: { surface: { re: '^[a-z][a-z0-9_-]{0,31}$' } } },
    guest_popup_seen: { props: { surface: { re: '^[a-z][a-z0-9_-]{0,31}$' } } },
    signup_start: { props: { method: { enum: ['email', 'google', 'apple'] }, surface: { re: '^[a-z][a-z0-9_-]{0,31}$' } } },
    // The guest ID only. No user_id, ever. auth_state must be "guest".
    sign_up: { props: { auth_state: { enum: ['guest'] }, method: { enum: ['email', 'google', 'apple'] }, surface: { re: '^[a-z][a-z0-9_-]{0,31}$' } }, required: { auth_state: 'guest' } },
    sign_in: { props: { method: { enum: ['email', 'google', 'apple'] }, surface: { re: '^[a-z][a-z0-9_-]{0,31}$' } } },
    guest_progress_moved: { props: { surface: { re: '^[a-z][a-z0-9_-]{0,31}$' } } },
    // Hub value event: a click on a site card. The slug is a code from sites.json, not text a visitor types.
    site_open: { props: { slug: { re: '^[a-z0-9-]{1,32}$' } }, apps: ['hub'] },
  },
};

// Prop names are split on _ and - ; none of these words may appear in a prop name, in any event, in any app.
export const BANNED_PROP_WORDS = [
  'email', 'mail', 'name', 'username', 'user', 'userid', 'account', 'password', 'token', 'ip', 'phone', 'address',
  'text', 'message', 'msg', 'prompt', 'query', 'search', 'note', 'notes', 'comment', 'free', 'title', 'body', 'content',
  'lat', 'lng', 'lon', 'latitude', 'longitude', 'location', 'coord', 'coords', 'route', 'place', 'city', 'gps',
  'verse', 'chapter', 'book', 'reading', 'passage', 'tradition', 'translation',
  'document', 'doc', 'booking', 'itinerary', 'reservation', 'flight',
  'camera', 'photo', 'image', 'frame', 'speech', 'voice', 'audio', 'transcript', 'ai', 'chat', 'answer',
];
