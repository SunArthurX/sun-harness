# Execution targets and jobs

Open **Settings → Execution targets** to see the current execution host,
its Local Docker option, and gateway installations saved and trusted by
that host. The list shows each target's reachability and identity state.
When the desktop is attached to a gateway, this section belongs to that
execution host. Select **Use this computer** in **Connections** to manage
jobs from the desktop host and use its saved gateway targets.

1. Select a ready target and an existing session on it. The session
   supplies the working directory and sandbox.
2. Enter a shell command and choose **Review job**. Confirm the target,
   session, and command, then choose **Start reviewed job**.
3. Use **Refresh jobs** or wait for the periodic refresh. **View job
   output** reads the output from the originating target. Files written
   by the command stay in that session's workspace.

**Local Docker** uses a session configured with the Docker sandbox and
an image already present on the local daemon. A job gets its own
temporary container. Cancellation checks the operation's container
identity and removes that container. For Docker jobs, an allowlist
configuration keeps outbound networking disabled.

If a launch acknowledgement is lost, the row shows **Reconciling**.
Sun Harness checks the original operation ID after reconnecting. A
refresh does not submit the shell command again. A cancellation request
stays visible until the provider acknowledges it or the job reaches
its observed outcome. An offline target can prevent cancellation or
output retrieval until it reconnects.

The controller retains operation IDs, target identities, provider job
IDs and observed state in `$SUN_HOME/execution-jobs`. Gateway profiles
and their credentials remain in the existing connections store. The
target's job manager retains its execution records and output. Explicit
shell jobs report their completion in the session without starting an
automatic model response.
