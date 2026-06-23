// Binds a Base wallet to user_wallets after hosted onboarding completes.
// Called by hosted page only — NOT Flutter. Ronin wallet_connections untouched.


const CHAIN = 'base'
const BIND_DOMAIN = 'amayatoken.online'
const CORS_ORIGIN = `https://${BIND_DOMAIN}`
const EIP1271_MAGIC = '0x1626ba7e'
const BASE_MAINNET_RPC =
  Deno.env.get('BASE_MAINNET_RPC_URL')?.trim() || 'https://mainnet.base.org'

const CDP_API_HOST = 'api.cdp.coinbase.com'
/** OpenAPI: server /platform + path /v2/end-users/auth/validate-token */
const CDP_VALIDATE_PATH = '/platform/v2/end-users/auth/validate-token'
const CDP_VALIDATE_URL = `https://${CDP_API_HOST}${CDP_VALIDATE_PATH}`
/** Claim `uri` for CDP server JWT — must match validate-token request exactly. */
const CDP_JWT_URI = `POST ${CDP_API_HOST}${CDP_VALIDATE_PATH}`



const CDP_API_KEY_SCOPE_HINT =
  'Check that Secret API Key belongs to the same CDP project as Non-custodial Wallet Project ID and has access to end-user wallet validation.';

const ALLOWED_PROVIDERS = new Set([
  'coinbase_embedded_wallet',
  'base_account',
  'coinbase_smart_wallet',
  'privy_embedded_wallet',
  'walletconnect',
  'coinbase_wallet',
  'base_wallet',
])

const BASE_MAINNET_CHAIN_ID = 8453

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': CORS_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-moveplus-base-bind-key',
}

type CdpAuthMethodEntry = {
  type?: string
  email?: string
}

type CdpEndUser = {
  userId?: string
  evmAccounts?: string[]
  evmAccountObjects?: Array<{ address?: string }>
  evmSmartAccounts?: string[]
  evmSmartAccountObjects?: Array<{
    address?: string
    ownerAddresses?: string[]
  }>
  authenticationMethods?:
    | CdpAuthMethodEntry[]
    | { email?: { email?: string } }
}

type CdpSafeError = {
  errorType?: string
  errorMessage?: string
  correlationId?: string
}

type CdpValidateErrorCode =
  | 'MISSING_CDP_API_SECRETS'
  | 'CDP_JWT_GENERATE_FAILED'
  | 'CDP_VALIDATE_HTTP_401'
  | 'CDP_VALIDATE_HTTP_403'
  | 'CDP_VALIDATE_HTTP_STATUS'
  | 'CDP_VALIDATE_RESPONSE_INVALID'
  | 'CDP_VALIDATE_NETWORK'

type CdpJwtAlgorithm = 'EdDSA' | 'ES256'

type CdpValidateResult =
  | { ok: true; endUser: CdpEndUser }
  | {
      ok: false
      errorCode: CdpValidateErrorCode
      httpStatus?: number
      cdpError?: CdpSafeError
      jwtGenerated: boolean
      jwtAlgorithm?: CdpJwtAlgorithm
    }

type CdpRejectionCategory =
  | 'credentials'
  | 'permission'
  | 'request_format'
  | 'project_or_resource_mismatch'
  | 'unknown'

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function jsonError(
  errorCode: string,
  status: number,
  extra: Record<string, unknown> = {},
) {
  return json({ success: false, error_code: errorCode, ...extra }, status)
}

function warnBind(
  stage: string,
  fields: Record<string, string | number | boolean | null> = {},
) {
  safeWarn('base_wallet_bind', stage, fields)
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function normalizeEvmAddress(raw: string): string | null {
  const s = raw.trim().toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(s)) return null
  return s
}

function truncateWalletAddress(address: string): string {
  const trimmed = address.trim()
  if (trimmed.length <= 12) return trimmed
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`
}

function isHumanVerificationValid(session: {
  human_verified_at?: string | null
  human_verification_expires_at?: string | null
}): boolean {
  if (!session.human_verified_at) return false
  const expMs = new Date(String(session.human_verification_expires_at ?? '')).getTime()
  if (!Number.isFinite(expMs) || Date.now() > expMs) return false
  return true
}

function buildExpectedBindMessage(sessionId: string, domain: string): string {
  return `Move+ Base wallet link\nSession: ${sessionId}\nDomain: ${domain}`
}

function bindMessageValid(
  signedMessage: string,
  session: { id: string },
  sessionToken: string,

function buildBaseWalletVerificationMessage(params: {
  walletAddress: string
  userId: string
  nonce: string
  issuedAt: string
  expiresAt: string
}): string {
  return [
    'Move+ Base Wallet Verification',
    '',
    `Wallet: ${params.walletAddress}`,
    `Chain: Base Mainnet (${BASE_MAINNET_CHAIN_ID})`,
    `User: ${params.userId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt}`,
    `Expires At: ${params.expiresAt}`,
  ].join('\n')
}

function walletSignatureMessageValid(
  signedMessage: string,
  session: {
    bind_nonce?: string | null
    bind_wallet_address?: string | null
    user_id: string
    created_at?: string | null
    expires_at: string
  },
  walletAddress: string,
): boolean {
  const nonce = String(session.bind_nonce ?? '').trim()
  const boundWallet = normalizeEvmAddress(
    String(session.bind_wallet_address ?? walletAddress),
  )
  const submittedWallet = normalizeEvmAddress(walletAddress)
  if (!nonce || !boundWallet || !submittedWallet || boundWallet !== submittedWallet) {
    return false
  }
  const issuedAt = session.created_at
    ? new Date(String(session.created_at)).toISOString()
    : ''
  const expiresAt = new Date(String(session.expires_at)).toISOString()
  if (!issuedAt) return false

  const expected = buildBaseWalletVerificationMessage({
    walletAddress: boundWallet,
    userId: String(session.user_id),
    nonce,
    issuedAt,
    expiresAt,
  })
  return signedMessage.trim() === expected
}

async function assertAuthenticatedSessionUser(
  supabaseUrl: string,
  anon: string,
  authHeader: string,
  sessionUserId: string,
): Promise<boolean> {
  if (!anon || !authHeader) return false
  const userClient = createClient(supabaseUrl, anon, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: authData, error: authErr } = await userClient.auth.getUser()
  if (authErr || !authData?.user) return false
  return String(authData.user.id) === String(sessionUserId)
}

function authorizeRequest(
  req: Request,
  hasWalletProof: boolean,
  bindSecret: string,
): boolean {
  if (!bindSecret) return true
  const headerKey = req.headers.get('x-moveplus-base-bind-key')?.trim() ?? ''
  if (headerKey && headerKey === bindSecret) return true
  return hasWalletProof
}

/** Email from CDP validate-token response only — never trust request body. */
function extractCdpAuthEmail(endUser: CdpEndUser): string | null {
  const methods = endUser.authenticationMethods
  if (!methods) return null

  if (Array.isArray(methods)) {
    for (const entry of methods) {
      const type = String(entry.type ?? '').toLowerCase()
      const email = String(entry.email ?? '').trim()
      if (
        email &&
        (type === 'email' || type === 'google' || type === 'apple')
      ) {
        return email
      }
    }
    return null
  }

  const sdkEmail = methods.email?.email
  return typeof sdkEmail === 'string' && sdkEmail.trim() ? sdkEmail.trim() : null
}


/** Safe prefix only — never log full CDP_API_KEY_ID. */
function cdpApiKeyIdPrefix(apiKeyId: string): string {
  const s = apiKeyId.trim()
  if (!s) return 'missing'
  if (s.length <= 8) return s.length >= 4 ? `${s.slice(0, 4)}…` : '***'
  return `${s.slice(0, 8)}…`
}

function cdpProjectIdSuffix(projectId: string): string | undefined {
  const s = projectId.trim()
  if (!s) return undefined
  if (s.length <= 6) return '***'
  return s.slice(-6)
}

function safeDecodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padLen = (4 - (padded.length % 4)) % 4
    const json = atob(padded + '='.repeat(padLen))
    const payload = JSON.parse(json)
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function cdpConfiguredProjectIdSuffix(): string | undefined {
  return cdpProjectIdSuffix(Deno.env.get('CDP_PROJECT_ID')?.trim() ?? '')
}

function cdpAccessTokenProjectIdSuffix(accessToken: string): string | undefined {
  const payload = safeDecodeJwtPayload(accessToken)
  const raw = payload?.project_id ?? payload?.projectId
  return typeof raw === 'string' ? cdpProjectIdSuffix(raw) : undefined
}

function cdpApiCredentials(): CdpApiCredentials | null {
  const fromId = Deno.env.get('CDP_API_KEY_ID')?.trim() ?? ''
  const fromLegacyName = Deno.env.get('CDP_API_KEY_NAME')?.trim() ?? ''
  const apiKeyId = fromId || fromLegacyName
  const apiKeySecret = Deno.env.get('CDP_API_KEY_SECRET')?.trim() ?? ''
  if (!apiKeyId || !apiKeySecret) return null

  return {
    apiKeyId,
    apiKeySecret,
    apiKeyIdFormat: detectCdpApiKeyIdFormat(apiKeyId),
    apiKeyIdSource: fromId ? 'CDP_API_KEY_ID' : 'CDP_API_KEY_NAME',
  }
}

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function cdpJwtNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function isEd25519CdpSecret(secret: string): boolean {
  try {
    return decodeBase64(secret).length === 64
  } catch {
    return false
  }
}

async function isEcCdpSecret(secret: string): Promise<boolean> {
  try {
    await importPKCS8(secret, 'ES256')
    return true
  } catch {
    return false
  }
}

async function detectCdpJwtAlgorithm(
  apiKeySecret: string,
): Promise<CdpJwtAlgorithm | null> {
  if (isEd25519CdpSecret(apiKeySecret)) return 'EdDSA'
  if (await isEcCdpSecret(apiKeySecret)) return 'ES256'
  return null
}


function sanitizeCdpErrorType(raw: unknown): string | undefined {
  const value = String(raw ?? '').trim()
  if (!value || !CDP_ERROR_TYPE_RE.test(value)) return undefined
  return value
}

function sanitizeCdpCorrelationId(raw: unknown): string | undefined {
  const value = String(raw ?? '').trim()
  if (!value || !CDP_CORRELATION_ID_RE.test(value)) return undefined
  return value
}

function sanitizeCdpErrorMessage(raw: unknown): string | undefined {
  const value = String(raw ?? '').trim().replace(/\s+/g, ' ')
  if (!value || value.length > 200) return undefined
  if (CDP_ERROR_MESSAGE_SENSITIVE_RE.test(value)) return undefined
  return value
}

function extractSafeCdpError(payload: Record<string, unknown>): CdpSafeError {
  const out: CdpSafeError = {}
  const errorType = sanitizeCdpErrorType(payload.errorType ?? payload.error_type)
  const correlationId = sanitizeCdpCorrelationId(
    payload.correlationId ?? payload.correlation_id,
  )
  const errorMessage = sanitizeCdpErrorMessage(
    payload.errorMessage ?? payload.error_message,
  )
  if (errorType) out.errorType = errorType
  if (correlationId) out.correlationId = correlationId
  if (errorMessage) out.errorMessage = errorMessage
  return out
}

async function parseCdpErrorResponse(
  response: Response,
): Promise<CdpSafeError | null> {
  try {
    const text = await response.text()
    if (!text.trim()) return null
    const payload = JSON.parse(text)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null
    }
    const safe = extractSafeCdpError(payload as Record<string, unknown>)
    return safe.errorType || safe.errorMessage || safe.correlationId
      ? safe
      : null
  } catch {
    return null
  }
}

function classifyCdpRejection(
  errorType: string | undefined,
  httpStatus: number,
): CdpRejectionCategory {
  const t = String(errorType ?? '').toLowerCase()
  if (httpStatus === 401 || t === 'unauthorized') return 'credentials'
  if (
    httpStatus === 403 ||
    t === 'forbidden' ||
    t === 'customer_not_authorized'
  ) {
    return 'permission'
  }
  if (
    t === 'invalid_request' ||
    t === 'malformed_request' ||
    t === 'validation_error'
  ) {
    return 'request_format'
  }
  if (t === 'not_found' || httpStatus === 404) {
    return 'project_or_resource_mismatch'
  }
  return 'unknown'
}

function cdpDebugResponseFields(
  validation: Extract<CdpValidateResult, { ok: false }>,
  accessToken?: string,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  fields.cdp_validate_endpoint = CDP_VALIDATE_PATH
  fields.cdp_jwt_uri = CDP_JWT_URI
  if (validation.httpStatus != null) {
    fields.cdp_http_status = validation.httpStatus
    fields.cdp_validate_http_status = validation.httpStatus
  }
  fields.cdp_jwt_generated = validation.jwtGenerated
  if (validation.jwtAlgorithm) {
    fields.cdp_jwt_algorithm = validation.jwtAlgorithm
  }
  if (validation.cdpError?.errorType) {
    fields.cdp_error_type = validation.cdpError.errorType
  }
  if (validation.cdpError?.errorMessage) {
    fields.cdp_error_message = validation.cdpError.errorMessage
  }
  if (validation.cdpError?.correlationId) {
    fields.cdp_correlation_id = validation.cdpError.correlationId
  }
  const category = classifyCdpRejection(
    validation.cdpError?.errorType,
    validation.httpStatus ?? 0,
  )
  if (category !== 'unknown') {
    fields.cdp_rejection_category = category
  }
  const creds = cdpApiCredentials()
  if (creds) {
    fields.cdp_api_key_id_format = creds.apiKeyIdFormat
    fields.cdp_api_key_id_prefix = cdpApiKeyIdPrefix(creds.apiKeyId)
  }
  const configProjectSuffix = cdpConfiguredProjectIdSuffix()
  if (configProjectSuffix) {
    fields.cdp_project_id_suffix = configProjectSuffix
  }
  if (accessToken) {
    const tokenProjectSuffix = cdpAccessTokenProjectIdSuffix(accessToken)
    if (configProjectSuffix && tokenProjectSuffix) {
      fields.cdp_project_id_match =
        configProjectSuffix === tokenProjectSuffix
    }
  }
  return fields
}



/** Minimal CDP REST JWT (EdDSA or ES256) — avoids bundling @coinbase/cdp-sdk. */
async function buildCdpBearerJwt(
  apiKeyId: string,
  apiKeySecret: string,
): Promise<{ jwt: string; algorithm: CdpJwtAlgorithm }> {
  const now = Math.floor(Date.now() / 1000)
  const expiresIn = 120
  const nonce = cdpJwtNonce()
  const claims = {
    sub: apiKeyId,
    iss: 'cdp',
    uri: CDP_JWT_URI,
  }

  if (isEd25519CdpSecret(apiKeySecret)) {
    const decoded = decodeBase64(apiKeySecret)
    const seed = decoded.subarray(0, 32)
    const publicKey = decoded.subarray(32, 64)
    const key = await importJWK(
      {
        kty: 'OKP',
        crv: 'Ed25519',
        d: toBase64Url(seed),
        x: toBase64Url(publicKey),
      },
      'EdDSA',
    )
    return {
      jwt: await new SignJWT(claims)
        .setProtectedHeader({ alg: 'EdDSA', kid: apiKeyId, typ: 'JWT', nonce })
        .setIssuedAt(now)
        .setNotBefore(now)
        .setExpirationTime(now + expiresIn)
        .sign(key),
      algorithm: 'EdDSA',
    }
  }

  if (await isEcCdpSecret(apiKeySecret)) {
    const ecKey = await importPKCS8(apiKeySecret, 'ES256')
    return {
      jwt: await new SignJWT(claims)
        .setProtectedHeader({ alg: 'ES256', kid: apiKeyId, typ: 'JWT', nonce })
        .setIssuedAt(now)
        .setNotBefore(now)
        .setExpirationTime(now + expiresIn)
        .sign(ecKey),
      algorithm: 'ES256',
    }
  }

  throw new Error('Invalid CDP API key secret format')
}

function collectCdpOwnedEvmAddresses(endUser: CdpEndUser): Set<string> {
  const out = new Set<string>()

  const add = (raw: unknown) => {
    if (typeof raw !== 'string') return
    const normalized = raw.trim().toLowerCase()
    if (/^0x[a-f0-9]{40}$/.test(normalized)) out.add(normalized)
  }

  for (const addr of endUser.evmAccounts ?? []) add(addr)
  for (const obj of endUser.evmAccountObjects ?? []) add(obj.address)
  for (const addr of endUser.evmSmartAccounts ?? []) add(addr)
  for (const obj of endUser.evmSmartAccountObjects ?? []) {
    add(obj.address)
    for (const owner of obj.ownerAddresses ?? []) add(owner)
  }

  return out
}

function cdpEndUserOwnsWallet(
  endUser: CdpEndUser,
  walletAddressNormalized: string,
): boolean {
  return collectCdpOwnedEvmAddresses(endUser).has(walletAddressNormalized)
}

function cdpValidateHttpErrorCode(status: number): CdpValidateErrorCode {
  if (status === 401) return 'CDP_VALIDATE_HTTP_401'
  if (status === 403) return 'CDP_VALIDATE_HTTP_403'
  return 'CDP_VALIDATE_HTTP_STATUS'
}

function cdpValidateFailureBody(errorCode: CdpValidateErrorCode) {
  const body: Record<string, unknown> = {
    message:
      'Base login worked, but wallet verification failed. Please try again later.',
  }
  if (
    errorCode === 'CDP_VALIDATE_HTTP_403' ||
    errorCode === 'CDP_VALIDATE_HTTP_STATUS'
  ) {
    body.hint = CDP_API_KEY_SCOPE_HINT
  }
  return body
}

async function validateCdpAccessToken(
  accessToken: string,
): Promise<CdpValidateResult> {
  const creds = cdpApiCredentials()
  if (!creds) {
    warnBind('cdp_validate', {
      error_code: 'MISSING_CDP_API_SECRETS',
      cdp_api_key_id_present: false,
      cdp_api_key_secret_present: false,
      jwt_generated: false,
    })
    return { ok: false, errorCode: 'MISSING_CDP_API_SECRETS', jwtGenerated: false }
  }

  const expectedAlgorithm = await detectCdpJwtAlgorithm(creds.apiKeySecret)
  const tokenProjectSuffix = cdpAccessTokenProjectIdSuffix(accessToken)
  const configProjectSuffix = cdpConfiguredProjectIdSuffix()
  warnBind('cdp_validate', {
    cdp_api_key_id_present: creds.apiKeyId.length > 0,
    cdp_api_key_id_format: creds.apiKeyIdFormat,
    cdp_api_key_id_prefix: cdpApiKeyIdPrefix(creds.apiKeyId),
    cdp_api_key_id_source: creds.apiKeyIdSource,
    cdp_api_key_secret_present: creds.apiKeySecret.length > 0,
    cdp_jwt_algorithm_expected: expectedAlgorithm ?? 'unrecognized_format',
    cdp_validate_endpoint: CDP_VALIDATE_PATH,
    cdp_jwt_uri: CDP_JWT_URI,
    cdp_project_id_suffix: configProjectSuffix ?? null,
    cdp_project_id_match:
      configProjectSuffix && tokenProjectSuffix
        ? configProjectSuffix === tokenProjectSuffix
        : null,
  })

  let jwtAlgorithm: CdpJwtAlgorithm | undefined
  let bearer: string
  try {
    const jwt = await buildCdpBearerJwt(creds.apiKeyId, creds.apiKeySecret)
    bearer = jwt.jwt
    jwtAlgorithm = jwt.algorithm
    warnBind('cdp_validate', {
      jwt_generated: true,
      jwt_algorithm: jwtAlgorithm,
      cdp_jwt_uri: CDP_JWT_URI,
    })
  } catch {
    warnBind('cdp_validate', {
      error_code: 'CDP_JWT_GENERATE_FAILED',
      jwt_generated: false,
      cdp_jwt_algorithm_expected: expectedAlgorithm ?? 'unrecognized_format',
    })
    return { ok: false, errorCode: 'CDP_JWT_GENERATE_FAILED', jwtGenerated: false }
  }

  let response: Response
  try {
    response = await fetch(CDP_VALIDATE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ accessToken }),
    })
  } catch {
    warnBind('cdp_validate', {
      error_code: 'CDP_VALIDATE_NETWORK',
      validate_token_reached: false,
      jwt_generated: true,
      jwt_algorithm: jwtAlgorithm ?? null,
    })
    return {
      ok: false,
      errorCode: 'CDP_VALIDATE_NETWORK',
      jwtGenerated: true,
      jwtAlgorithm,
    }
  }

  warnBind('cdp_validate', {
    validate_token_reached: true,
    cdp_validate_http_status: response.status,
    jwt_generated: true,
    jwt_algorithm: jwtAlgorithm ?? null,
  })

  if (!response.ok) {
    const cdpError = await parseCdpErrorResponse(response)
    const errorCode = cdpValidateHttpErrorCode(response.status)
    warnBind('cdp_validate', {
      error_code: errorCode,
      cdp_validate_http_status: response.status,
      cdp_error_type: cdpError?.errorType ?? null,
      cdp_correlation_id: cdpError?.correlationId ?? null,
      cdp_rejection_category: classifyCdpRejection(
        cdpError?.errorType,
        response.status,
      ),
      jwt_generated: true,
      jwt_algorithm: jwtAlgorithm ?? null,
    })
    return {
      ok: false,
      errorCode,
      httpStatus: response.status,
      cdpError: cdpError ?? undefined,
      jwtGenerated: true,
      jwtAlgorithm,
    }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    warnBind('cdp_validate', { error_code: 'CDP_VALIDATE_RESPONSE_INVALID' })
    return {
      ok: false,
      errorCode: 'CDP_VALIDATE_RESPONSE_INVALID',
      jwtGenerated: true,
      jwtAlgorithm,
    }
  }

  if (!payload || typeof payload !== 'object') {
    warnBind('cdp_validate', { error_code: 'CDP_VALIDATE_RESPONSE_INVALID' })
    return {
      ok: false,
      errorCode: 'CDP_VALIDATE_RESPONSE_INVALID',
      jwtGenerated: true,
      jwtAlgorithm,
    }
  }

  return { ok: true, endUser: payload as CdpEndUser }
}

async function verifyEip1271(
  address: string,
  message: string,
  signature: string,
): Promise<boolean> {
  const digest = hashMessage(message)
  const iface = new Interface([
    'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
  ])
  const data = iface.encodeFunctionData('isValidSignature', [digest, signature])
  try {
    const res = await fetch(BASE_MAINNET_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: address, data }, 'latest'],
      }),
    })

async function verifyWalletOwnership(
  address: string,
  message: string,
  signature: string,
): Promise<boolean> {
  try {
    const recovered = verifyMessage(message, signature)
    if (recovered.toLowerCase() === address.toLowerCase()) return true
  } catch {
    // fall through to EIP-1271
  }
  return await verifyEip1271(address, message, signature)
}

type PrivyLinkedAccount = {
  type?: string
  address?: string
  chain_type?: string
}

type PrivyApiUser = {
  id?: string
  linked_accounts?: PrivyLinkedAccount[]
}

async function verifyPrivyAccessToken(
  accessToken: string,
): Promise<{ userId: string } | null> {
  const appId = Deno.env.get('PRIVY_APP_ID')?.trim()
  if (!appId) {
    warnBind('privy_verify', { error_code: 'PRIVY_APP_ID_MISSING' })
    return null
  }

  try {
    const JWKS = createRemoteJWKSet(
      new URL(`https://auth.privy.io/v1/apps/${appId}/jwks.json`),
    )
    const { payload } = await jwtVerify(accessToken, JWKS, {
      issuer: 'privy.io',
      audience: appId,
    })
    const sub = payload.sub
    if (typeof sub !== 'string' || !sub.trim()) return null
    return { userId: sub.trim() }
  } catch {
    warnBind('privy_verify', { error_code: 'PRIVY_JWT_INVALID' })
    return null
  }
}

async function fetchPrivyUser(userId: string): Promise<PrivyApiUser | null> {
  const appId = Deno.env.get('PRIVY_APP_ID')?.trim()
  const appSecret = Deno.env.get('PRIVY_APP_SECRET')?.trim()
  if (!appId || !appSecret) {
    warnBind('privy_user_fetch', { error_code: 'PRIVY_API_CREDENTIALS_MISSING' })
    return null
  }

  try {
    const basic = btoa(`${appId}:${appSecret}`)
    const res = await fetch(
      `https://api.privy.io/v1/users/${encodeURIComponent(userId)}`,
      {
        headers: {
          Authorization: `Basic ${basic}`,
          'privy-app-id': appId,
        },
      },
    )
    if (!res.ok) {
      warnBind('privy_user_fetch', {
        error_code: 'PRIVY_USER_HTTP',
        http_status: res.status,
      })
      return null
    }
    return (await res.json()) as PrivyApiUser
  } catch {
    warnBind('privy_user_fetch', { error_code: 'PRIVY_USER_NETWORK' })
    return null
  }
}

function privyUserOwnsWallet(
  user: PrivyApiUser,
  normalizedWallet: string,
): boolean {
  for (const acct of user.linked_accounts ?? []) {
    if (String(acct.type ?? '').toLowerCase() !== 'wallet') continue
    const chain = String(acct.chain_type ?? 'ethereum').toLowerCase()
    if (chain !== 'ethereum') continue
    const addr = normalizeEvmAddress(String(acct.address ?? ''))
    if (addr === normalizedWallet) return true
  }
  return false
}

function extractPrivyAuthEmail(user: PrivyApiUser): string | null {
  for (const acct of user.linked_accounts ?? []) {
    if (String(acct.type ?? '').toLowerCase() !== 'email') continue
    const email = String(acct.address ?? '').trim()
    if (email.includes('@')) return email
  }
  return null
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return json({ success: false, error: 'Method not allowed' }, 405)
  }

  warnBind('request_start', { method: 'POST' })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const anon = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  if (!supabaseUrl || !service) {
    return json({ success: false, error: 'Server misconfigured' }, 500)
  }

  let body: {
    session_token?: string
    onboarding_session_token?: string
    wallet_address?: string
    wallet_auth_email?: string
    wallet_provider?: string
    signature?: string
    signed_message?: string
    message?: string
    cdp_access_token?: string
    privy_access_token?: string
    privy_user_id?: string
    proof_method?: string
    chain_id?: number | string
  }
  try {
    body = await req.json()
  } catch {
    return json({ success: false, error: 'Invalid JSON' }, 400)
  }

  const sessionToken = (
    body.session_token ?? body.onboarding_session_token ?? ''
  ).trim()
  const walletRaw = (body.wallet_address ?? '').trim()
  const provider = String(body.wallet_provider ?? '').trim().toLowerCase()
  const signature = String(body.signature ?? '').trim()
  const signedMessage = String(
    body.signed_message ?? body.message ?? '',
  ).trim()
  const cdpAccessToken = String(body.cdp_access_token ?? '').trim()
  const privyAccessToken = String(body.privy_access_token ?? '').trim()
  const privyUserIdBody = String(body.privy_user_id ?? '').trim()
  const proofMethod = String(body.proof_method ?? '').trim().toLowerCase()
  const chainIdRaw = body.chain_id
  const chainId = chainIdRaw != null ? Number(chainIdRaw) : null

  const hasWalletSignatureProof =
    proofMethod === 'wallet_signature' &&
    signature.length > 0 &&
    signedMessage.length > 0
  const hasPrivyProof =
    proofMethod === 'privy' && privyAccessToken.length > 0
  const hasCdpTokenProof =
    cdpAccessToken.length > 0 &&
    (proofMethod === 'cdp_access_token' || proofMethod === '')
  const hasLegacySignatureProof =
    !hasWalletSignatureProof &&
    signature.length > 0 &&
    signedMessage.length > 0
  const hasWalletProof =
    hasCdpTokenProof ||
    hasLegacySignatureProof ||
    hasWalletSignatureProof ||
    hasPrivyProof

  const bindSecret = Deno.env.get('BASE_WALLET_BIND_SECRET')?.trim() ?? ''
  const headerKey = req.headers.get('x-moveplus-base-bind-key')?.trim() ?? ''
  const usedHeaderAuth =
    bindSecret.length > 0 &&
    headerKey.length > 0 &&
    headerKey === bindSecret

  if (!authorizeRequest(req, hasWalletProof, bindSecret)) {
    warnBind('auth_check', {
      error_code: 'BIND_UNAUTHORIZED',
      has_wallet_proof: hasWalletProof,
      bind_secret_configured: bindSecret.length > 0,
    })
    return jsonError('BIND_UNAUTHORIZED', 403)
  }

  warnBind('auth_check', {
    has_wallet_proof: hasWalletProof,
    proof_method: proofMethod ||
      (hasWalletSignatureProof
        ? 'wallet_signature'
        : hasPrivyProof
        ? 'privy'
        : 'cdp_access_token'),
    used_header_auth: usedHeaderAuth,
  })

  if (!sessionToken) {
    return json({ success: false, error: 'Missing session_token' }, 400)
  }

  const normalized = normalizeEvmAddress(walletRaw)
  if (!normalized) {
    return json({ success: false, error: 'Invalid wallet address' }, 400)
  }

  if (!ALLOWED_PROVIDERS.has(provider)) {
    return json({ success: false, error: 'Invalid wallet_provider' }, 400)
  }

  const admin = createClient(supabaseUrl, service)
  const tokenHash = await sha256Hex(sessionToken)


  if (session.used_at) {
    warnBind('session_lookup', { error_code: 'SESSION_ALREADY_USED' })
    return jsonError('SESSION_ALREADY_USED', 403, {
      message: 'Onboarding session already used',
    })
  }

  if (session.intended_chain !== CHAIN) {
    warnBind('session_lookup', { error_code: 'SESSION_INVALID', chain_mismatch: true })
    return jsonError('SESSION_INVALID', 403, {
      message: 'Invalid onboarding session chain',
    })
  }

  const exp = new Date(String(session.expires_at)).getTime()
  if (!Number.isFinite(exp) || Date.now() > exp) {
    warnBind('session_lookup', { error_code: 'SESSION_EXPIRED' })
    return jsonError('SESSION_EXPIRED', 403, {
      message: 'Onboarding session expired',
    })
  }

  if (hasCdpTokenProof && !isHumanVerificationValid(session)) {
    warnBind('human_verification', {
      error_code: 'BASE_ONBOARDING_HUMAN_VERIFICATION_REQUIRED',
      human_verified: false,
    })
    return jsonError('BASE_ONBOARDING_HUMAN_VERIFICATION_REQUIRED', 403, {
      message: 'Security check required before Base sign-in.',
    })
  }

  let verifiedAuthEmail: string | null = null
  let resolvedProofMethod = usedHeaderAuth
    ? 'header'
    : hasWalletSignatureProof
    ? 'wallet_signature'
    : hasPrivyProof
    ? 'privy'
    : hasCdpTokenProof
    ? 'cdp_access_token'
    : 'signature'

  if (!usedHeaderAuth) {
    if (hasWalletSignatureProof) {
      if (chainId !== BASE_MAINNET_CHAIN_ID) {
        return jsonError('INVALID_CHAIN_ID', 400, {
          message: 'Wallet verification failed. Please try again.',
        })
      }

      const authHeader = req.headers.get('Authorization') ?? ''
      const authed = await assertAuthenticatedSessionUser(
        supabaseUrl,
        anon,
        authHeader,
        String(session.user_id),
      )
      if (!authed) {
        return jsonError('BIND_UNAUTHORIZED', 403)
      }

      if (
        !String(session.bind_nonce ?? '').trim() ||
        !normalizeEvmAddress(String(session.bind_wallet_address ?? ''))
      ) {
        warnBind('wallet_signature', { error_code: 'SESSION_INVALID' })
        return jsonError('SESSION_INVALID', 403, {
          message: 'Invalid onboarding session',
        })
      }

      if (!walletSignatureMessageValid(signedMessage, session, normalized)) {
        warnBind('wallet_signature', { error_code: 'MESSAGE_INVALID' })
        return jsonError('WALLET_OWNERSHIP_UNVERIFIED', 403, {
          message: 'Wallet verification failed. Please try again.',
        })
      }

      let recovered: string
      try {
        recovered = verifyMessage(signedMessage, signature)
      } catch {
        return jsonError('WALLET_OWNERSHIP_UNVERIFIED', 403, {
          message: 'Wallet verification failed. Please try again.',
        })
      }
      if (normalizeEvmAddress(recovered) !== normalized) {
        warnBind('wallet_ownership', { wallet_ownership_matched: false })
        return jsonError('WALLET_OWNERSHIP_UNVERIFIED', 403, {
          message: 'Wallet verification failed. Please try again.',
        })
      }
      warnBind('wallet_ownership', { wallet_ownership_matched: true })
    } else if (hasPrivyProof) {
      const authHeader = req.headers.get('Authorization') ?? ''
      if (!anon || !authHeader) {
        return jsonError('BIND_UNAUTHORIZED', 403)
      }
      const userClient = createClient(supabaseUrl, anon, {
        global: { headers: { Authorization: authHeader } },
      })
      const { data: authData, error: authErr } = await userClient.auth.getUser()
      if (authErr || !authData?.user) {
        return jsonError('BIND_UNAUTHORIZED', 403)
      }
      if (String(authData.user.id) !== String(session.user_id)) {
        return jsonError('BIND_UNAUTHORIZED', 403, {
          message: 'Session does not match authenticated user',
        })
      }

      warnBind('privy_verify', { stage: 'start' })
      const tokenClaims = await verifyPrivyAccessToken(privyAccessToken)
      if (!tokenClaims) {
        return jsonError('PRIVY_VERIFICATION_FAILED', 403, {
          message: 'Wallet verification failed. Please try again.',
        })
      }
      if (
        privyUserIdBody &&
        privyUserIdBody !== tokenClaims.userId
      ) {
        return jsonError('PRIVY_VERIFICATION_FAILED', 403, {
          message: 'Wallet verification failed. Please try again.',
        })
      }

      const privyUser = await fetchPrivyUser(tokenClaims.userId)
      if (!privyUser) {
        return jsonError('PRIVY_VERIFICATION_FAILED', 403, {
          message: 'Wallet verification failed. Please try again.',
        })
      }

      const ownsWallet = privyUserOwnsWallet(privyUser, normalized)
      warnBind('wallet_ownership', { wallet_ownership_matched: ownsWallet })
      if (!ownsWallet) {
        return jsonError('WALLET_OWNERSHIP_UNVERIFIED', 403, {
          message: 'Wallet verification failed. Please try again.',
        })
      }

      verifiedAuthEmail = extractPrivyAuthEmail(privyUser)
    } else if (hasCdpTokenProof) {
      warnBind('cdp_validate', { stage: 'start' })
      const validation = await validateCdpAccessToken(cdpAccessToken)
      if (!validation.ok) {
        warnBind('cdp_validate', {
          error_code: validation.errorCode,
          cdp_validate_http_status: validation.httpStatus ?? null,
          cdp_error_type: validation.cdpError?.errorType ?? null,
          cdp_correlation_id: validation.cdpError?.correlationId ?? null,
        })
        if (validation.errorCode === 'MISSING_CDP_API_SECRETS') {
          return jsonError('MISSING_CDP_API_SECRETS', 500)
        }
        if (validation.errorCode === 'CDP_JWT_GENERATE_FAILED') {
          return jsonError('CDP_JWT_GENERATE_FAILED', 500, {
            cdp_jwt_generated: false,
          })
        }
        if (validation.errorCode === 'CDP_VALIDATE_NETWORK') {
          return jsonError('CDP_VALIDATE_NETWORK', 502, {
            message: 'Base login worked, but wallet verification failed.',
            ...cdpDebugResponseFields(validation, cdpAccessToken),
          })
        }
        const publicErrorCode = mapCdpValidatePublicErrorCode(validation)
        return jsonError(
          publicErrorCode,
          403,
          {
            ...cdpValidateFailureBody(validation.errorCode),
            ...cdpDebugResponseFields(validation, cdpAccessToken),
            cdp_validate_error_code: validation.errorCode,
          },
        )
      }

      const ownsWallet = cdpEndUserOwnsWallet(validation.endUser, normalized)
      warnBind('wallet_ownership', { wallet_ownership_matched: ownsWallet })
      if (!ownsWallet) {
        return jsonError('CDP_WALLET_OWNERSHIP_UNVERIFIED', 403, {
          message:
            'Base login worked, but wallet verification failed.',
        })
      }

      verifiedAuthEmail = extractCdpAuthEmail(validation.endUser)
    } else if (hasLegacySignatureProof) {
      if (!bindMessageValid(signedMessage, session, sessionToken)) {
        return json({
          success: false,
          error: 'Invalid signed_message for this onboarding session',
        }, 400)
      }
      const verified = await verifyWalletOwnership(
        normalized,
        signedMessage,
        signature,
      )
      if (!verified) {
        warnBind('wallet_ownership', { wallet_ownership_matched: false })
        return jsonError('WALLET_OWNERSHIP_UNVERIFIED', 403, {
          message: 'Base login worked, but wallet verification failed.',
        })
      }
      warnBind('wallet_ownership', { wallet_ownership_matched: true })
    } else {
      return jsonError('CDP_ACCESS_TOKEN_REQUIRED', 400, {
        error: 'wallet proof required',
        message: 'Wallet verification failed. Please try again.',
      })
    }
  }

  const userId = String(session.user_id)

  warnBind('user_wallets_upsert', { stage: 'start' })

  const { data: addressOwner } = await admin
    .from('user_wallets')
    .select('user_id')
    .eq('chain', CHAIN)
    .eq('wallet_address_normalized', normalized)
    .eq('is_active', true)
    .maybeSingle()

  if (addressOwner && String(addressOwner.user_id) !== userId) {
    return json({
      success: false,
      error_code: 'WALLET_ALREADY_IN_USE',
      message: 'This Base wallet is already linked to another Move+ account.',
    }, 400)
  }

  const { data: existingActiveRow } = await admin
    .from('user_wallets')
    .select('id, wallet_address, wallet_address_normalized')
    .eq('user_id', userId)
    .eq('chain', CHAIN)
    .eq('is_active', true)
    .order('verified_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const setPrimary = !existingActiveRow
  const nowIso = new Date().toISOString()

  const { data: existingSame } = await admin
    .from('user_wallets')
    .select('id')
    .eq('user_id', userId)
    .eq('chain', CHAIN)
    .eq('wallet_address_normalized', normalized)
    .maybeSingle()

  if (existingActiveRow) {
    const activeNormalized = normalizeEvmAddress(
      String(existingActiveRow.wallet_address_normalized ?? existingActiveRow.wallet_address ?? ''),
    )
    if (activeNormalized && activeNormalized !== normalized) {
      const boundAddress = String(
        existingActiveRow.wallet_address ?? existingActiveRow.wallet_address_normalized ?? '',
      )
      warnBind('user_wallets_upsert', {
        error_code: 'BASE_WALLET_ADDRESS_MISMATCH',
        bound_wallet_truncated: truncateWalletAddress(boundAddress),
      })
      return json({
        success: false,
        error_code: 'BASE_WALLET_ADDRESS_MISMATCH',
        message:
          'This account already has a different Move+ Base Wallet. Assets are tied to the wallet address.',
        current_wallet_address_truncated: truncateWalletAddress(boundAddress),
      }, 409)
    }
  }

  if (existingSame?.id) {
    const { error: updErr } = await admin
      .from('user_wallets')
      .update({
        wallet_address: normalized,
        wallet_provider: provider,
        wallet_auth_email: verifiedAuthEmail,
        is_active: true,
        verified_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', existingSame.id)

    if (updErr) {
      warnBind('user_wallets_upsert', {
        error_code: 'USER_WALLET_UPSERT_FAILED',
        operation: 'update',
      })
      return jsonError('USER_WALLET_UPSERT_FAILED', 500)
    }
  } else {
    const { error: insErr } = await admin.from('user_wallets').insert({
      user_id: userId,
      chain: CHAIN,
      wallet_address: normalized,
      wallet_address_normalized: normalized,
      wallet_provider: provider,
      wallet_auth_email: verifiedAuthEmail,
      is_primary: setPrimary,
      is_active: true,
      verified_at: nowIso,
      updated_at: nowIso,
    })

    if (insErr) {
      if (String(insErr.message ?? '').includes('unique') || insErr.code === '23505') {
        return json({
          success: false,
          error_code: 'WALLET_ALREADY_IN_USE',
          message: 'This Base wallet is already linked to another Move+ account.',
        }, 400)
      }
      warnBind('user_wallets_upsert', {
        error_code: 'USER_WALLET_UPSERT_FAILED',
        operation: 'insert',
      })
      return jsonError('USER_WALLET_UPSERT_FAILED', 500)
    }
  }

  warnBind('user_wallets_upsert', { success: true })

  const claimIso = new Date().toISOString()
  const { data: claimed, error: claimErr } = await admin
    .from('base_onboarding_sessions')
    .update({ used_at: claimIso })
    .eq('id', session.id)
    .is('used_at', null)
    .select('id')
    .maybeSingle()

  if (claimErr || !claimed) {
    warnBind('session_claim', { error_code: 'SESSION_ALREADY_USED' })
    return jsonError('SESSION_ALREADY_USED', 403, {
      message: 'Onboarding session already used',
    })
  }

