const hasControls = (value, allowLayout = false) =>
  [...value].some((character) => {
    const code = character.codePointAt(0);
    return (
      code === 127 || (code < 32 && !(allowLayout && [9, 10].includes(code)))
    );
  });

exports.normalizeTeamName = (value) => value.normalize('NFC').trim();
exports.isCanonicalTeamName = (value) =>
  typeof value === 'string' &&
  value === exports.normalizeTeamName(value) &&
  [...value].length >= 1 &&
  [...value].length <= 200 &&
  !hasControls(value);

exports.normalizeTeamCode = (value) =>
  value.trim().replace(/[a-z]/g, (letter) => letter.toUpperCase());
exports.isCanonicalTeamCode = (value) =>
  typeof value === 'string' &&
  value === exports.normalizeTeamCode(value) &&
  value.length >= 2 &&
  value.length <= 32 &&
  /^[A-Z][A-Z0-9_-]*$/u.test(value);

exports.isValidTeamDescription = (value) =>
  value === null ||
  (typeof value === 'string' &&
    [...value].length <= 2000 &&
    !hasControls(value, true));

exports.isValidTeamVersion = (value) =>
  Number.isSafeInteger(value) && value >= 1;

exports.normalizeArchivedReason = (value) => value.trim();
exports.isCanonicalArchivedReason = (value) =>
  typeof value === 'string' &&
  value === exports.normalizeArchivedReason(value) &&
  [...value].length >= 1 &&
  [...value].length <= 500 &&
  !hasControls(value);
