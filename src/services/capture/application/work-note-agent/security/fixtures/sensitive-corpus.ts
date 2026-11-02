/**
 * Synthetic sensitive-data corpus for tests. Values are FAKE and assembled at runtime
 * (string concatenation) so repository secret scanners do not flag the fixtures.
 */
const j = (...parts: string[]) => parts.join('');
const rep = (s: string, n: number) => s.repeat(n);

export const FAKE = {
  awsAccessKey: j('AKIA', 'Z7Q2', 'XW9R', 'K3M8', 'P1T5'),
  awsSecret: j('wJalrXUtnFEMI', '/K7MDENG/bPxRfiCY', 'EXAMPLEKEY'),
  googleApiKey: j('AIza', 'SyD3', rep('aB9_', 7), 'x7Q'),
  openAiKey: j('sk-', 'proj-', 'Q8v', rep('Zk3Lm', 6)),
  stripeKey: j('sk', '_live_', rep('4eC39HqLyjWDarjtT1zdp7dc', 1)),
  githubToken: j('gh', 'p_', rep('A1b2C3d4E5f6', 3)),
  gitlabToken: j('glp', 'at-', rep('xY7zQ', 5)),
  slackToken: j('xo', 'xb-', '123456789012-', rep('AbCdEf', 4)),
  sendgridKey: j('SG', '.', rep('Ab3dEf', 4), '.', rep('Gh5jKl', 5)),
  jwt: j(
    'eyJ',
    'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    '.',
    'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ',
    '.',
    'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  ),
  bearer: j('Abc', rep('9xY2kL', 4), 'Zq'),
  dbPassword: 'S3cr3t!Pass#2026',
  mongoUri: (password: string) =>
    j('mongodb', '+srv://admin:', password, '@cluster0.ab1cd.mongodb.net/app'),
  envSecret: j('a8F3', rep('kQ9z', 5), 'P0'),
  privateKey: j(
    '-----BEGIN ',
    'RSA PRIVATE KEY-----\n',
    'MIIEowIBAAKCAQEA',
    rep('q1W2e3R4', 6),
    '\n-----END RSA ',
    'PRIVATE KEY-----',
  ),
  personalEmail: 'nguyen.van.a1990@gmail.com',
  internalEmail: 'dev.lead@continuum.vn',
  phone: '0912 345 678',
  phoneIntl: '+84 987654321',
  cccd: '079203001234',
  cmnd: '123456789',
  visaCard: '4111 1111 1111 1111',
  napasCard: '9704 0000 0000 0018',
  bankAccount: '0011004567890',
};

/** Positive samples: [label, text, expected category, expected value]. */
export const POSITIVE_SAMPLES: readonly [string, string, string, string][] = [
  [
    'aws access key',
    `AWS key: ${FAKE.awsAccessKey}`,
    'CLOUD_KEY',
    FAKE.awsAccessKey,
  ],
  [
    'aws secret',
    `aws_secret_access_key = ${FAKE.awsSecret}`,
    'CLOUD_KEY',
    FAKE.awsSecret,
  ],
  [
    'google api key',
    `maps key ${FAKE.googleApiKey} cho FE`,
    'CLOUD_KEY',
    FAKE.googleApiKey,
  ],
  ['openai key', `OPENAI=${FAKE.openAiKey}`, 'API_KEY', FAKE.openAiKey],
  ['stripe key', `dùng ${FAKE.stripeKey} để test`, 'API_KEY', FAKE.stripeKey],
  [
    'github token',
    `token gh: ${FAKE.githubToken}`,
    'API_KEY',
    FAKE.githubToken,
  ],
  ['gitlab token', `CI dùng ${FAKE.gitlabToken}`, 'API_KEY', FAKE.gitlabToken],
  ['slack token', `bot ${FAKE.slackToken}`, 'API_KEY', FAKE.slackToken],
  ['sendgrid key', `mail key ${FAKE.sendgridKey}`, 'API_KEY', FAKE.sendgridKey],
  ['jwt', `Gửi kèm ${FAKE.jwt} khi gọi API`, 'TOKEN', FAKE.jwt],
  ['bearer', `Authorization: Bearer ${FAKE.bearer}`, 'TOKEN', FAKE.bearer],
  [
    'password assignment',
    `DB_PASSWORD=${FAKE.dbPassword}`,
    'PASSWORD',
    FAKE.dbPassword,
  ],
  [
    'vietnamese password',
    `mật khẩu: ${FAKE.dbPassword}`,
    'PASSWORD',
    FAKE.dbPassword,
  ],
  [
    'vietnamese password statement',
    'mật khẩu là Abc@12345',
    'PASSWORD',
    'Abc@12345',
  ],
  ['mk shorthand', 'tài khoản admin, mk: hello2026', 'PASSWORD', 'hello2026'],
  [
    'connection string',
    `kết nối ${FAKE.mongoUri('Pa55word99')}`,
    'CONNECTION_STRING',
    'Pa55word99',
  ],
  ['env secret', `JWT_SECRET=${FAKE.envSecret}`, 'CREDENTIAL', FAKE.envSecret],
  [
    'api key header',
    `x-api-key: ${FAKE.envSecret}`,
    'CREDENTIAL',
    FAKE.envSecret,
  ],
  [
    'personal email',
    `liên hệ ${FAKE.personalEmail} nhé`,
    'EMAIL',
    FAKE.personalEmail,
  ],
  ['phone', `SĐT khách: ${FAKE.phone}`, 'PHONE', FAKE.phone],
  ['phone intl', `gọi ${FAKE.phoneIntl}`, 'PHONE', FAKE.phoneIntl],
  ['cccd bare', `CCCD ${FAKE.cccd}`, 'NATIONAL_ID', FAKE.cccd],
  ['cmnd with label', `số CMND: ${FAKE.cmnd}`, 'NATIONAL_ID', FAKE.cmnd],
  ['visa card', `thẻ ${FAKE.visaCard}`, 'BANK_CARD', FAKE.visaCard],
  ['napas card', `thẻ ATM ${FAKE.napasCard}`, 'BANK_CARD', FAKE.napasCard],
  [
    'bank account',
    `STK: ${FAKE.bankAccount} Vietcombank`,
    'BANK_ACCOUNT',
    FAKE.bankAccount,
  ],
];

/** Negative samples: ordinary engineering prose that must NOT be flagged. */
export const NEGATIVE_SAMPLES: readonly string[] = [
  'Đã sửa lỗi timeout 30000ms ở API /api/v1/tasks, p95 giảm còn 120ms.',
  'Commit a3f9c2e1b7d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2 đã merge vào main.',
  'Task CON-1234 cần review. Version v2.3.1 phát hành ngày 2026-11-02.',
  'password là bắt buộc khi đăng ký; token hết hạn sau 3600 giây.',
  'Cấu hình MAX_TOKENS=4096 và TOKEN_EXPIRES_IN=3600 trong .env.example.',
  'Đặt DB_PASSWORD=${DB_PASSWORD} và API_KEY=<your-api-key> trong file mẫu.',
  'const token = getToken(); const secret = process.env.JWT_SECRET;',
  'password: string; apiKey?: string; // kiểu dữ liệu DTO',
  'Đọc file src/services/capture/application/work-note-agent/work-note-agent.ts',
  'ObjectId 6ad7758334bd88b3f2cc844d của task được giữ nguyên.',
  'Gửi email tới user@example.com để test luồng reset.',
  'Clone bằng git@github.com:org/repo.git rồi chạy npm install.',
  'Đã xử lý 1234567 bản ghi, tỉ lệ lỗi 0.25%, thời gian 2h30m.',
  'Basic authentication bị tắt cho môi trường staging.',
  'Test pass: 95% (120/126 case).',
  'Timestamp 1730534400000 dùng để đối chiếu log.',
];
