# T12 native toolchain checkpoint

Run `node apps/desktop/e2e/computer-native-probe.mjs` after a signed
desktop bundle is available. An optional first argument selects another
signed source bundle. The fixture copies the bundle into a temporary
directory, changes the copy to a probe-specific bundle identifier,
compiles the Swift helper, signs the copy and verifies it before launch.
The source bundle is preserved. LaunchServices opens the copy with an
isolated settings and browser directory.

On Apple silicon with macOS 15.7.2, Swift 5.8.1, and SDK 13.3, the
macOS 13 deployment-target helper built and ran as a bundled child.
The probe matched the isolated foreground application. The mismatched
process returned without window inspection. Screen Recording and
Accessibility both returned `permission-required` for the disposable
identity, and the positive AX window-role check was not reached.
See [captured command output](T12-native-probe.txt).

The probe calls the no-prompt permission APIs and reads at most the
role of the focused test window. It compares the foreground
`NSRunningApplication` instance against the expected application and
checks it again before accepting the AX result. It sends no native input
and takes no screenshots. The probe's TCC results apply to the probe
bundle identity. Recheck permissions in the production bundle during
T12 acceptance. [Accessibility trust check](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions) · [Foreground application API](https://developer.apple.com/documentation/appkit/nsworkspace/frontmostapplication)

## Production gate

T11 passed its signed capture fixture, and T12 subsequently passed its
own [signed native acceptance](T12.json). The implementation carried
forward the bundled helper and bounded AX query pattern. Validate the
target application instance and window at snapshot and before each
dispatch. Keep app grants, runtime approvals, and OS permissions
separate. Emergency stop invalidates the lease before cancelling a
pending native call. Do not retry an action whose dispatch outcome is
unknown. The private sign-in window requires an independent deny path.
Record actual observation and action against a synthetic app after
the relevant OS permissions have been granted.

The controller enforces one short-lived lease and one action per
observation. Its fixture counts dispatches and verifies permission
denial, revocation, window changes, receipt write failure, takeover,
and stale references across restart. The desktop host integration
verifies runtime approval, a flushed session receipt, and gateway
method rejection. The signed app exposes the bilingual Computer Use
panel, bundles the native helper, and refused control without
Accessibility permission. See the [tests](T12-test.txt), [build](T12-build.txt),
[type checks](T12-types.txt), [signing log](T12-package.txt), and
[packaged denial preflight](T12-preflight.txt).

For the positive fixture, authorize the exact signed bundle at
`apps/desktop/release/computer-verified/mac-arm64/sun-harness.app` under
macOS **Privacy & Security → Accessibility**, then run
`node apps/desktop/e2e/computer.mjs`. The fixture uses a synthetic
AppKit window, a loopback model, and temporary session data. It checks
for zero presses before approval, one press after approval, a separate
approved text edit, and revocation when a private sign-in window opens.
After the exact path was selected in the system app chooser, both
Electron main and the native helper reported authorization. The
[strict run](T12-native-current.txt) and its
[expanded repeat](T12-native-repeat.txt) passed. The signed bundle
passed its separate Keychain regression after the user authorized the
Keychain prompt.
