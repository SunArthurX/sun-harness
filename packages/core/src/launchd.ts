import { dirname } from 'node:path';

const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A macOS LaunchAgent plist. Node runs directly: no shell rc is executed and no secret is written here. */
export function launchAgentPlist(opts: {
  label: string;
  nodePath: string;
  args: string[];
  log: string;
  /** Daily start time; omit for a service. */
  calendar?: { hour: number; minute: number };
  /** Keep the process running (restart on exit) and start at login. */
  keepAlive?: boolean;
  path?: string;
}): string {
  const PATH = opts.path ?? `${dirname(opts.nodePath)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${x(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
${[opts.nodePath, ...opts.args].map((a) => `    <string>${x(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${x(PATH)}</string></dict>
${opts.calendar ? `  <key>StartCalendarInterval</key>\n  <dict><key>Hour</key><integer>${opts.calendar.hour}</integer><key>Minute</key><integer>${opts.calendar.minute}</integer></dict>\n` : ''}  <key>RunAtLoad</key>${opts.keepAlive ? '<true/>' : '<false/>'}
${opts.keepAlive ? '  <key>KeepAlive</key><true/>\n' : ''}  <key>StandardOutPath</key><string>${x(opts.log)}</string>
  <key>StandardErrorPath</key><string>${x(opts.log)}</string>
</dict>
</plist>
`;
}
