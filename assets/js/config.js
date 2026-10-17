// Public, client-side configuration. The publishable key is designed to be shipped to browsers;
// access is enforced by Row Level Security in Supabase, not by hiding this key.
window.BOBO_CONFIG = {
  supabaseUrl: "https://ywcrzkvwamjchjjkfrve.supabase.co",
  supabaseKey: "sb_publishable_Mqep-YSoDCfQ0eLYez5ZDw_VaZpDL0M",
  // Session cookie is shared across every *.bobolearns.com site so one login works everywhere.
  cookieDomain: ".bobolearns.com",
  rootHost: "bobolearns.com",
  contactEmail: "hello@bobolearns.com", // TODO: confirm this mailbox exists (also referenced in /privacy and /terms)
  creator: { name: "Babar Ali", url: "https://babarali.com" }
};
