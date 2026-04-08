const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/tasks'
];

const createOAuth2Client = () => new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback'
);

const createGmailClient = (tokens) => {
  const auth = createOAuth2Client();
  auth.setCredentials(tokens);
  return google.gmail({ version: 'v1', auth });
};

module.exports = { SCOPES, createOAuth2Client, createGmailClient };
