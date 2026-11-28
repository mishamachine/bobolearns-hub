// Public, client-side configuration. The publishable key is designed to be shipped to browsers;
// access is enforced by Row Level Security in Supabase, not by hiding this key.
window.BOBO_CONFIG = {
  supabaseUrl: "https://ywcrzkvwamjchjjkfrve.supabase.co",
  supabaseKey: "sb_publishable_Mqep-YSoDCfQ0eLYez5ZDw_VaZpDL0M",
  // Session cookie is shared across every *.bobolearns.com site so one login works everywhere.
  cookieDomain: ".bobolearns.com",
  rootHost: "bobolearns.com",
  contactEmail: "machinemisha@gmail.com",
  // Flip apple to true once Sign in with Apple is configured in Supabase (needs an Apple Developer account).
  providers: { google: true, apple: false },
  // First-party usage counts (guest events). OFF until the privacy copy is final and the server side is applied.
  // Nothing is sent, and no ID is created, while enabled is false.
  analytics: { enabled: false, app: "hub", endpoint: "https://ywcrzkvwamjchjjkfrve.supabase.co/functions/v1/events" },
  creator: { name: "Babar Ali", url: "https://babarali.com" }
};
