# Computer Use

Computer Use is available on the supported macOS desktop with a local
execution host. It uses the system Accessibility tree of one foreground
window. The model can observe accessible text and controls, press an
accessible control, and set an editable, non-secure text field.

1. Launch the desktop app you want to control. Open **Settings → Computer
   Use** in Sun Harness. If needed, choose **Open Accessibility settings**,
   enable this Sun Harness build, and refresh the panel.
2. Choose the running application. Review its name and bundle identifier,
   then select **Allow selected app**. Select a chat and choose **Start
   computer control**. One chat can hold the local lease at a time.
3. Send your prompt and bring the assigned app to the foreground. If your
   session policy prompts for approval, review the action in the chat,
   approve it, and return to the same app and window promptly. A fresh
   observation is required after each action.
4. Use **Stop computer control** in the chat or **Take over computer
   control** in Settings. The assignment expires after one minute.
   **Revoke app access** removes the stored grant and stops its active
   assignment. Restart clears the lease.

Accessible text returned to the model is part of the session record.
The private website sign-in window and secure Accessibility fields
are excluded. The native adapter does not click screen coordinates,
type global keystrokes, switch apps, or use browser automation.

An interrupted action can have an uncertain outcome if dispatch had
already started. Inspect the target before issuing another action.
The session keeps a receipt, and restart never restores an old control
lease. The web UI, CLI, and gateway connections cannot assign native
desktop control.

For local signed acceptance, add the exact bundle path with the **+**
button in macOS Accessibility. A different build with the same display
name can have its own authorization. The [signed acceptance record](../plans/settings-competitors/evidence/T12.json)
lists the isolated fixture and its test results.
