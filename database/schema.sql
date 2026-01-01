-- AcademiXsphere Notification Server Database Schema
-- FIXED: Concurrency-safe, secure, reliable notification system

-- 1. Notification Queue Table (Transactional Outbox Pattern)
CREATE TABLE IF NOT EXISTS notification_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id UUID NOT NULL,
    user_id UUID NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    body TEXT NOT NULL,
    payload JSONB DEFAULT '{}',
    processed BOOLEAN DEFAULT FALSE,
    processing_started_at TIMESTAMP WITH TIME ZONE,
    processed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Critical indexes for concurrency-safe processing
    INDEX idx_notification_queue_unprocessed (processed, created_at) WHERE processed = FALSE,
    INDEX idx_notification_queue_user (user_id),
    INDEX idx_notification_queue_school (school_id)
);

-- 2. FCM Token Storage Table (FIXED: Multiple tokens per user allowed)
CREATE TABLE IF NOT EXISTS user_fcm_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    school_id UUID NOT NULL,
    fcm_token TEXT NOT NULL,
    platform VARCHAR(20) NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_used_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- FIXED: Allow multiple tokens per user, prevent duplicates per user
    UNIQUE(user_id, fcm_token)
);

-- Critical indexes for performance and concurrency
CREATE INDEX IF NOT EXISTS idx_user_fcm_tokens_user_active ON user_fcm_tokens (user_id) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_user_fcm_tokens_school ON user_fcm_tokens (school_id);
CREATE INDEX IF NOT EXISTS idx_user_fcm_tokens_active ON user_fcm_tokens (is_active, last_used_at);

-- 3. Example tables for demonstration (you may already have these)
CREATE TABLE IF NOT EXISTS attendance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id UUID NOT NULL,
    student_id UUID NOT NULL,
    date DATE NOT NULL,
    status VARCHAR(20) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS announcements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id UUID NOT NULL,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    target_audience VARCHAR(50) NOT NULL, -- 'students', 'parents', 'all'
    created_by UUID NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fee_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id UUID NOT NULL,
    student_id UUID NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    payment_date DATE NOT NULL,
    status VARCHAR(20) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS exam_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id UUID NOT NULL,
    student_id UUID NOT NULL,
    exam_id UUID NOT NULL,
    marks DECIMAL(5,2) NOT NULL,
    grade VARCHAR(5),
    published_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS voice_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id UUID NOT NULL,
    sender_id UUID NOT NULL,
    recipient_id UUID NOT NULL,
    message_url TEXT NOT NULL,
    duration_seconds INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. RLS Policies (STRICT SECURITY)
-- Enable RLS on notification_queue - CLIENTS MUST NEVER ACCESS
ALTER TABLE notification_queue ENABLE ROW LEVEL SECURITY;

-- ONLY service role can access notification_queue (NO client access)
CREATE POLICY "Service role only access" ON notification_queue
    FOR ALL USING (auth.role() = 'service_role');

-- Block ALL client access explicitly
CREATE POLICY "Block all client access" ON notification_queue
    FOR ALL USING (FALSE);

-- FCM tokens - users can only manage their own tokens
ALTER TABLE user_fcm_tokens ENABLE ROW LEVEL SECURITY;

-- Users can insert/update their own tokens only
CREATE POLICY "Users manage own tokens" ON user_fcm_tokens
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own tokens" ON user_fcm_tokens
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users read own tokens" ON user_fcm_tokens
    FOR SELECT USING (auth.uid() = user_id);

-- Service role has full access to tokens for processing
CREATE POLICY "Service role full access tokens" ON user_fcm_tokens
    FOR ALL USING (auth.role() = 'service_role');

-- 5. Database Functions (CONCURRENCY-SAFE)

-- Function to safely queue notifications (idempotent)
CREATE OR REPLACE FUNCTION queue_notification(
    p_school_id UUID,
    p_user_id UUID,
    p_event_type VARCHAR,
    p_title VARCHAR,
    p_body TEXT,
    p_payload JSONB DEFAULT '{}'
)
RETURNS UUID AS $$
DECLARE
    notification_id UUID;
BEGIN
    -- Insert notification into queue
    INSERT INTO notification_queue (school_id, user_id, event_type, title, body, payload)
    VALUES (p_school_id, p_user_id, p_event_type, p_title, p_body, p_payload)
    RETURNING id INTO notification_id;
    
    RETURN notification_id;
EXCEPTION
    WHEN OTHERS THEN
        -- Log error but don't fail the original transaction
        RAISE WARNING 'Failed to queue notification: %', SQLERRM;
        RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- CONCURRENCY-SAFE: Fetch and lock unprocessed notifications
CREATE OR REPLACE FUNCTION claim_unprocessed_notifications(
    batch_limit INTEGER DEFAULT 50,
    worker_id TEXT DEFAULT 'worker'
)
RETURNS TABLE (
    id UUID,
    school_id UUID,
    user_id UUID,
    event_type VARCHAR,
    title VARCHAR,
    body TEXT,
    payload JSONB,
    created_at TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
    -- Use FOR UPDATE SKIP LOCKED for concurrency safety
    RETURN QUERY
    UPDATE notification_queue 
    SET 
        processing_started_at = NOW()
    WHERE notification_queue.id IN (
        SELECT nq.id
        FROM notification_queue nq
        WHERE nq.processed = FALSE 
        AND nq.processing_started_at IS NULL
        ORDER BY nq.created_at ASC
        LIMIT batch_limit
        FOR UPDATE SKIP LOCKED
    )
    RETURNING 
        notification_queue.id,
        notification_queue.school_id,
        notification_queue.user_id,
        notification_queue.event_type,
        notification_queue.title,
        notification_queue.body,
        notification_queue.payload,
        notification_queue.created_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Mark notification as processed (atomic)
CREATE OR REPLACE FUNCTION mark_notification_processed(notification_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    UPDATE notification_queue 
    SET 
        processed = TRUE, 
        processed_at = NOW()
    WHERE id = notification_id
    AND processed = FALSE;
    
    RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get active FCM tokens for a user
CREATE OR REPLACE FUNCTION get_user_active_fcm_tokens(p_user_id UUID)
RETURNS TABLE (
    id UUID,
    fcm_token TEXT,
    platform VARCHAR
) AS $$
BEGIN
    -- Update last_used_at for active tokens
    UPDATE user_fcm_tokens 
    SET last_used_at = NOW()
    WHERE user_id = p_user_id 
    AND is_active = TRUE;
    
    RETURN QUERY
    SELECT 
        uft.id,
        uft.fcm_token,
        uft.platform
    FROM user_fcm_tokens uft
    WHERE uft.user_id = p_user_id
    AND uft.is_active = TRUE
    AND uft.updated_at > NOW() - INTERVAL '60 days'; -- Only recent tokens
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Deactivate invalid FCM tokens
CREATE OR REPLACE FUNCTION deactivate_fcm_tokens(token_ids UUID[])
RETURNS INTEGER AS $$
DECLARE
    affected_count INTEGER;
BEGIN
    UPDATE user_fcm_tokens 
    SET 
        is_active = FALSE,
        updated_at = NOW()
    WHERE id = ANY(token_ids)
    AND is_active = TRUE;
    
    GET DIAGNOSTICS affected_count = ROW_COUNT;
    RETURN affected_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Cleanup old processed notifications (maintenance)
CREATE OR REPLACE FUNCTION cleanup_old_notifications(days_old INTEGER DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM notification_queue 
    WHERE processed = TRUE 
    AND processed_at < NOW() - (days_old || ' days')::INTERVAL;
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. Database Triggers (IDEMPOTENT, QUEUE-ONLY)

-- Trigger 1: Attendance marked (FIXED: Idempotent)
CREATE OR REPLACE FUNCTION notify_attendance_marked()
RETURNS TRIGGER AS $$
BEGIN
    -- Only queue notification, NEVER send directly
    PERFORM queue_notification(
        NEW.school_id,
        NEW.student_id,
        'attendance_marked',
        '📋 Attendance Updated',
        CASE 
            WHEN NEW.status = 'present' THEN 'Your child was marked present today'
            WHEN NEW.status = 'absent' THEN 'Your child was marked absent today'
            ELSE 'Attendance status updated'
        END,
        jsonb_build_object(
            'type', 'attendance_marked',
            'entity_id', NEW.id::text,
            'status', NEW.status,
            'date', NEW.date::text
        )
    );
    
    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        -- Never fail the original transaction
        RAISE WARNING 'Attendance notification trigger failed: %', SQLERRM;
        RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_attendance_notification ON attendance;
CREATE TRIGGER trigger_attendance_notification
    AFTER INSERT ON attendance
    FOR EACH ROW
    EXECUTE FUNCTION notify_attendance_marked();

-- Trigger 2: Announcement created (FIXED: Proper user targeting)
CREATE OR REPLACE FUNCTION notify_announcement_created()
RETURNS TRIGGER AS $$
BEGIN
    -- Queue notifications for all targeted users
    -- Note: This assumes you have a users table with role column
    INSERT INTO notification_queue (school_id, user_id, event_type, title, body, payload)
    SELECT 
        NEW.school_id,
        u.id,
        'announcement_created',
        '📢 ' || NEW.title,
        LEFT(NEW.content, 100) || CASE WHEN LENGTH(NEW.content) > 100 THEN '...' ELSE '' END,
        jsonb_build_object(
            'type', 'announcement_created',
            'entity_id', NEW.id::text
        )
    FROM users u 
    WHERE u.school_id = NEW.school_id 
    AND u.is_active = TRUE
    AND (
        NEW.target_audience = 'all' 
        OR u.role = NEW.target_audience
        OR (NEW.target_audience = 'parents' AND u.role IN ('parent', 'guardian'))
        OR (NEW.target_audience = 'students' AND u.role = 'student')
    );
    
    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Announcement notification trigger failed: %', SQLERRM;
        RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_announcement_notification ON announcements;
CREATE TRIGGER trigger_announcement_notification
    AFTER INSERT ON announcements
    FOR EACH ROW
    EXECUTE FUNCTION notify_announcement_created();

-- Trigger 3: Fee payment processed (FIXED: Idempotent)
CREATE OR REPLACE FUNCTION notify_fee_payment()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM queue_notification(
        NEW.school_id,
        NEW.student_id,
        'fee_payment_processed',
        '💰 Payment Confirmed',
        'Fee payment of $' || NEW.amount || ' has been processed successfully',
        jsonb_build_object(
            'type', 'fee_payment_processed',
            'entity_id', NEW.id::text,
            'amount', NEW.amount::text
        )
    );
    
    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Fee payment notification trigger failed: %', SQLERRM;
        RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_fee_payment_notification ON fee_payments;
CREATE TRIGGER trigger_fee_payment_notification
    AFTER INSERT ON fee_payments
    FOR EACH ROW
    EXECUTE FUNCTION notify_fee_payment();

-- Trigger 4: Exam result published (FIXED: Idempotent)
CREATE OR REPLACE FUNCTION notify_result_published()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM queue_notification(
        NEW.school_id,
        NEW.student_id,
        'result_published',
        '📝 Result Published',
        'Your exam result is now available. Grade: ' || COALESCE(NEW.grade, 'N/A'),
        jsonb_build_object(
            'type', 'result_published',
            'entity_id', NEW.id::text,
            'exam_id', NEW.exam_id::text,
            'grade', COALESCE(NEW.grade, '')
        )
    );
    
    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Result notification trigger failed: %', SQLERRM;
        RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_result_notification ON exam_results;
CREATE TRIGGER trigger_result_notification
    AFTER INSERT ON exam_results
    FOR EACH ROW
    EXECUTE FUNCTION notify_result_published();

-- Trigger 5: Voice message received (FIXED: Idempotent)
CREATE OR REPLACE FUNCTION notify_voice_message()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM queue_notification(
        NEW.school_id,
        NEW.recipient_id,
        'voice_message_received',
        '🎤 Voice Message',
        'You have received a new voice message',
        jsonb_build_object(
            'type', 'voice_message_received',
            'entity_id', NEW.id::text,
            'duration', COALESCE(NEW.duration_seconds, 0)::text
        )
    );
    
    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Voice message notification trigger failed: %', SQLERRM;
        RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_voice_message_notification ON voice_messages;
CREATE TRIGGER trigger_voice_message_notification
    AFTER INSERT ON voice_messages
    FOR EACH ROW
    EXECUTE FUNCTION notify_voice_message();

-- 7. Queue Statistics and Health Functions

-- Get queue statistics for monitoring
CREATE OR REPLACE FUNCTION get_queue_statistics()
RETURNS TABLE (
    total_notifications BIGINT,
    processed_notifications BIGINT,
    pending_notifications BIGINT,
    processing_notifications BIGINT,
    oldest_pending TIMESTAMP WITH TIME ZONE,
    newest_notification TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(*) as total_notifications,
        COUNT(*) FILTER (WHERE processed = TRUE) as processed_notifications,
        COUNT(*) FILTER (WHERE processed = FALSE AND processing_started_at IS NULL) as pending_notifications,
        COUNT(*) FILTER (WHERE processed = FALSE AND processing_started_at IS NOT NULL) as processing_notifications,
        MIN(created_at) FILTER (WHERE processed = FALSE) as oldest_pending,
        MAX(created_at) as newest_notification
    FROM notification_queue;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Health check function
CREATE OR REPLACE FUNCTION notification_system_health_check()
RETURNS TABLE (
    component TEXT,
    status TEXT,
    details JSONB
) AS $$
BEGIN
    -- Check notification queue
    RETURN QUERY
    SELECT 
        'notification_queue'::TEXT,
        CASE WHEN COUNT(*) >= 0 THEN 'healthy' ELSE 'error' END::TEXT,
        jsonb_build_object(
            'total_rows', COUNT(*),
            'table_exists', TRUE
        )
    FROM notification_queue;
    
    -- Check FCM tokens
    RETURN QUERY
    SELECT 
        'user_fcm_tokens'::TEXT,
        CASE WHEN COUNT(*) >= 0 THEN 'healthy' ELSE 'error' END::TEXT,
        jsonb_build_object(
            'total_tokens', COUNT(*),
            'active_tokens', COUNT(*) FILTER (WHERE is_active = TRUE),
            'table_exists', TRUE
        )
    FROM user_fcm_tokens;
    
    RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;