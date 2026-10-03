export type SecondFactor = 'email' | 'totp' | 'passkey' | 'recovery';
export type LoginResult = { id: number; requiresTwoFactor?: false } | { requiresTwoFactor: true; methods: SecondFactor[] };
export interface SecurityStatus {
  enabled: boolean;
  email: boolean;
  totp: boolean;
  passkeys: Array<{ id: string; name: string; createdAt: number }>;
  recoveryRemaining: number;
  emailAvailable: boolean;
  mailAvailable: boolean;
  totpAvailable: boolean;
  passkeysAvailable: boolean;
  reauthenticated: boolean;
  hasPassword: boolean;
}
export interface SecurityChallenge {
  methods: SecondFactor[];
  expiresAt: number;
  email: string | null;
  account: string;
  purpose: 'login' | 'reauth';
}
