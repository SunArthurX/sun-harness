import type { GatewayStatus } from '@sun/core';

export interface CertificatePreview {
  id: string;
  url: string;
  fingerprint: string;
}

export interface ConfirmConnection {
  id: string;
  fingerprint: string;
  name: string;
  token: string;
}

export interface DesktopConnections {
  selected?: string;
  profiles: { name: string; url: string; fingerprint?: string; hostId?: string; label?: string }[];
  status?: GatewayStatus;
}
