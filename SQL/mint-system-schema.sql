-- ============================================
-- MOVE+ MINT SYSTEM SCHEMA
-- Production Hardening: Backend Trust Enforcement
-- ============================================

-- ============================================
-- MINT SESSIONS TABLE
-- Tracks active minting sessions per user
-- ============================================
CREATE TABLE IF NOT EXISTS mint_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_nonce BIGINT NOT NULL,                    -- Cryptographic session nonce
    last_accepted_sequence INTEGER NOT NULL DEFAULT -1, -- Last accepted sequence number
    last_minted_distance DOUBLE PRECISION NOT NULL DEFAULT 0.0, -- Last distance that was minted
    last_minted_energy INTEGER NOT NULL DEFAULT 0,    -- Last energy that was minted
    activity_type TEXT NOT NULL CHECK (activity_type IN ('walk', 'run', 'cycle')),
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,      -- Session expires after 24h inactivity
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Unique constraint: one active session per user
    UNIQUE(user_id, session_nonce)
);

CREATE INDEX idx_mint_sessions_user_id ON mint_sessions(user_id, is_active);
CREATE INDEX idx_mint_sessions_nonce ON mint_sessions(session_nonce);
CREATE INDEX idx_mint_sessions_expires ON mint_sessions(expires_at) WHERE is_active = TRUE;

-- Enable RLS
ALTER TABLE mint_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own mint sessions"
    ON mint_sessions FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage all mint sessions"
    ON mint_sessions FOR ALL
    USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================
-- MINT AUDIT LOGS TABLE
-- Comprehensive audit trail for all mint attempts
-- ============================================
CREATE TABLE IF NOT EXISTS mint_audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_nonce BIGINT NOT NULL,
    request_id TEXT NOT NULL,                         -- Unique request identifier
    activity_type TEXT NOT NULL,
    
    -- Request data
    location_packet_count INTEGER NOT NULL,
    total_distance_meters DOUBLE PRECISION NOT NULL,
    last_minted_distance DOUBLE PRECISION NOT NULL,
    device_model TEXT,
    device_os TEXT,
    app_version TEXT,
    
    -- Validation results
    validation_passed BOOLEAN NOT NULL,
    error_code TEXT,                                  -- Error code if validation failed
    error_message TEXT,
    anomaly_score DOUBLE PRECISION,                   -- 0.0-1.0 anomaly score
    
    -- Mint results (if successful)
    minted_energy INTEGER,
    minted_distance DOUBLE PRECISION,
    total_energy_after INTEGER,
    
    -- Session state after request
    last_accepted_sequence INTEGER,
    
    -- Metadata
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_mint_audit_user_id ON mint_audit_logs(user_id, created_at DESC);
CREATE INDEX idx_mint_audit_session ON mint_audit_logs(session_nonce, created_at DESC);
CREATE INDEX idx_mint_audit_validation ON mint_audit_logs(validation_passed, created_at DESC);
CREATE INDEX idx_mint_audit_anomaly ON mint_audit_logs(anomaly_score) WHERE anomaly_score >= 0.7;

-- Enable RLS
ALTER TABLE mint_audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own audit logs"
    ON mint_audit_logs FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage all audit logs"
    ON mint_audit_logs FOR ALL
    USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================
-- MINT COOLDOWNS TABLE
-- Tracks cooldown periods for users
-- ============================================
CREATE TABLE IF NOT EXISTS mint_cooldowns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    error_code TEXT NOT NULL,                         -- Error code that triggered cooldown
    cooldown_seconds INTEGER NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(user_id, error_code)
);

CREATE INDEX idx_mint_cooldowns_user_id ON mint_cooldowns(user_id, expires_at);
CREATE INDEX idx_mint_cooldowns_expires ON mint_cooldowns(expires_at);

-- Enable RLS
ALTER TABLE mint_cooldowns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage all cooldowns"
    ON mint_cooldowns FOR ALL
    USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================
-- MINT RATE LIMITS TABLE
-- Tracks rate limiting per user/IP
-- ============================================
CREATE TABLE IF NOT EXISTS mint_rate_limits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    identifier TEXT NOT NULL,                           -- user_id or IP address
    identifier_type TEXT NOT NULL CHECK (identifier_type IN ('user', 'ip')),
    request_count INTEGER NOT NULL DEFAULT 1,
    window_start TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(identifier, identifier_type, window_start)
);

CREATE INDEX idx_mint_rate_limits_identifier ON mint_rate_limits(identifier, identifier_type, expires_at);
CREATE INDEX idx_mint_rate_limits_expires ON mint_rate_limits(expires_at);

-- Enable RLS (service role only)
ALTER TABLE mint_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage all rate limits"
    ON mint_rate_limits FOR ALL
    USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- Function: Get or create mint session
CREATE OR REPLACE FUNCTION get_or_create_mint_session(
    p_user_id UUID,
    p_session_nonce BIGINT,
    p_activity_type TEXT
)
RETURNS mint_sessions AS $$
DECLARE
    v_session mint_sessions;
BEGIN
    -- Try to get existing active session
    SELECT * INTO v_session
    FROM mint_sessions
    WHERE user_id = p_user_id
      AND session_nonce = p_session_nonce
      AND is_active = TRUE
      AND expires_at > NOW()
    LIMIT 1;
    
    -- If session exists, update last_activity_at
    IF v_session IS NOT NULL THEN
        UPDATE mint_sessions
        SET last_activity_at = NOW(),
            expires_at = NOW() + INTERVAL '24 hours'
        WHERE id = v_session.id;
        
        RETURN v_session;
    END IF;
    
    -- Create new session
    INSERT INTO mint_sessions (
        user_id,
        session_nonce,
        activity_type,
        expires_at
    ) VALUES (
        p_user_id,
        p_session_nonce,
        p_activity_type,
        NOW() + INTERVAL '24 hours'
    )
    RETURNING * INTO v_session;
    
    RETURN v_session;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function: Check if user is in cooldown
CREATE OR REPLACE FUNCTION check_mint_cooldown(
    p_user_id UUID,
    p_error_code TEXT DEFAULT NULL
)
RETURNS INTEGER AS $$
DECLARE
    v_cooldown_seconds INTEGER;
BEGIN
    -- Check for specific error code cooldown
    IF p_error_code IS NOT NULL THEN
        SELECT cooldown_seconds INTO v_cooldown_seconds
        FROM mint_cooldowns
        WHERE user_id = p_user_id
          AND error_code = p_error_code
          AND expires_at > NOW()
        LIMIT 1;
        
        IF v_cooldown_seconds IS NOT NULL THEN
            RETURN EXTRACT(EPOCH FROM (
                SELECT expires_at FROM mint_cooldowns
                WHERE user_id = p_user_id
                  AND error_code = p_error_code
                  AND expires_at > NOW()
                LIMIT 1
            ) - NOW())::INTEGER;
        END IF;
    END IF;
    
    -- Check for any active cooldown
    SELECT EXTRACT(EPOCH FROM (expires_at - NOW()))::INTEGER INTO v_cooldown_seconds
    FROM mint_cooldowns
    WHERE user_id = p_user_id
      AND expires_at > NOW()
    ORDER BY expires_at DESC
    LIMIT 1;
    
    RETURN COALESCE(v_cooldown_seconds, 0);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function: Set mint cooldown
CREATE OR REPLACE FUNCTION set_mint_cooldown(
    p_user_id UUID,
    p_error_code TEXT,
    p_cooldown_seconds INTEGER
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO mint_cooldowns (
        user_id,
        error_code,
        cooldown_seconds,
        expires_at
    ) VALUES (
        p_user_id,
        p_error_code,
        p_cooldown_seconds,
        NOW() + (p_cooldown_seconds || ' seconds')::INTERVAL
    )
    ON CONFLICT (user_id, error_code)
    DO UPDATE SET
        cooldown_seconds = p_cooldown_seconds,
        expires_at = NOW() + (p_cooldown_seconds || ' seconds')::INTERVAL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function: Check rate limit
CREATE OR REPLACE FUNCTION check_mint_rate_limit(
    p_identifier TEXT,
    p_identifier_type TEXT,
    p_limit_per_minute INTEGER DEFAULT 10
)
RETURNS BOOLEAN AS $$
DECLARE
    v_count INTEGER;
    v_window_start TIMESTAMP WITH TIME ZONE;
BEGIN
    -- Get current window start (minute boundary)
    v_window_start := date_trunc('minute', NOW());
    
    -- Get request count in current window
    SELECT request_count INTO v_count
    FROM mint_rate_limits
    WHERE identifier = p_identifier
      AND identifier_type = p_identifier_type
      AND window_start = v_window_start;
    
    -- If no record, create one
    IF v_count IS NULL THEN
        INSERT INTO mint_rate_limits (
            identifier,
            identifier_type,
            request_count,
            window_start,
            expires_at
        ) VALUES (
            p_identifier,
            p_identifier_type,
            1,
            v_window_start,
            v_window_start + INTERVAL '1 minute'
        );
        RETURN TRUE;
    END IF;
    
    -- Check if limit exceeded
    IF v_count >= p_limit_per_minute THEN
        RETURN FALSE;
    END IF;
    
    -- Increment count
    UPDATE mint_rate_limits
    SET request_count = request_count + 1
    WHERE identifier = p_identifier
      AND identifier_type = p_identifier_type
      AND window_start = v_window_start;
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function: Increment user energy points
CREATE OR REPLACE FUNCTION increment_user_energy(
    p_user_id UUID,
    p_points INTEGER
)
RETURNS INTEGER AS $$
DECLARE
    v_new_energy INTEGER;
BEGIN
    -- Update user energy
    UPDATE users
    SET energy_points = energy_points + p_points
    WHERE id = p_user_id
    RETURNING energy_points INTO v_new_energy;
    
    RETURN v_new_energy;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function: Clean up expired sessions and rate limits
CREATE OR REPLACE FUNCTION cleanup_mint_data()
RETURNS VOID AS $$
BEGIN
    -- Deactivate expired sessions
    UPDATE mint_sessions
    SET is_active = FALSE
    WHERE expires_at < NOW()
      AND is_active = TRUE;
    
    -- Delete expired cooldowns
    DELETE FROM mint_cooldowns
    WHERE expires_at < NOW();
    
    -- Delete expired rate limits
    DELETE FROM mint_rate_limits
    WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- AUTOMATIC CLEANUP (Optional: Run via cron)
-- ============================================
-- Note: Supabase doesn't support cron directly
-- Consider using pg_cron extension or external scheduler

COMMENT ON TABLE mint_sessions IS 'Tracks active minting sessions with cryptographic nonces';
COMMENT ON TABLE mint_audit_logs IS 'Comprehensive audit trail for all mint attempts';
COMMENT ON TABLE mint_cooldowns IS 'Tracks cooldown periods for users after errors';
COMMENT ON TABLE mint_rate_limits IS 'Tracks rate limiting per user/IP address';

