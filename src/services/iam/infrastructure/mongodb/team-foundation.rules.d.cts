declare const teamFoundationRules: {
  isCanonicalTeamName(value: unknown): boolean;
  isCanonicalTeamCode(value: unknown): boolean;
  isValidTeamDescription(value: unknown): boolean;
  isValidTeamVersion(value: unknown): boolean;
  isCanonicalArchivedReason(value: unknown): boolean;
};

export = teamFoundationRules;
