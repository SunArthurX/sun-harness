# Website passwords and private sign-in

On the macOS desktop app, open **Settings → Passwords**. This vault is
local to your desktop, including when the app is connected to a gateway.
Provider API credentials still use their existing settings.

1. Choose **Add website password**. Enter the site's HTTPS address, a
   recognizable account label, and its password. The vault binds the
   password to the site's scheme, hostname, and port.
2. Choose **Private sign-in** for the saved entry. Review the sign-in URL
   and select **Open private sign-in**. Its origin must match the saved
   origin. Enter your username and advance to the password step as needed.
3. With the password field visible, choose **Fill saved password** in the
   desktop controls above the site. Review and submit the form yourself.
4. Close the window when finished. This clears the temporary login state.

Each fill applies to the current top-level page. Sites that need
cross-origin identity providers, embedded password fields, or more than
one visible password field may require manual sign-in. The existing
[browser takeover](browser.md) flow works separately. Use it when you
want to log in on the agent's own browser profile.

The private window stays outside agent browser observations, gateway
views, and session exports. Appshot capture pauses while it is open.
The login and cookies stay in the private window, including after you
sign in. The desktop vault uses a macOS Keychain-backed encryption key.
When the vault is unavailable, use the manual sign-in flow. Reopening
the Passwords section checks the vault again.

Use **Replace password** to update a saved entry. **Remove password**
requires confirmation and invalidates future fills, including in a
private window already open. Removing an entry does not change the
password at the website. The audit log records the action, its outcome,
and the opaque credential reference.
