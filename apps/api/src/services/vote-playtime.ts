export interface PlayRequirement {
  kind: 'modpack' | 'server_type';
  target: string;
  minSeconds: number;
}
export interface PlayEligibilityRequest {
  userId: number;
  playerUuids: readonly string[];
  requirements: readonly PlayRequirement[];
}
export interface ServerBackendVoteAdapter {
  available: boolean;
  check(request: PlayEligibilityRequest): Promise<'eligible' | 'ineligible' | 'unavailable'>;
}
export const serverBackendVoteAdapter: ServerBackendVoteAdapter = {
  available: false,
  async check(_request) { return 'unavailable'; },
};
