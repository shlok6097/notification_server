-- Test notification system by manually inserting data
-- Run these queries in your Supabase SQL editor to test the FIXED system

-- 1. First, insert test FCM tokens (FIXED: Multiple tokens per user allowed)
INSERT INTO user_fcm_tokens (user_id, school_id, fcm_token, platform)
VALUES 
    ('your-user-uuid-here', 'your-school-uuid-here', 'your-actual-fcm-token-android', 'android'),
    ('your-user-uuid-here', 'your-school-uuid-here', 'your-actual-fcm-token-ios', 'ios')
ON CONFLICT (user_id, fcm_token) DO UPDATE SET
    updated_at = NOW(),
    is_active = TRUE;

-- 2. Test attendance notification (FIXED: Proper payload structure)
INSERT INTO attendance (school_id, student_id, date, status)
VALUES (
    'your-school-uuid-here',
    'your-user-uuid-here',
    CURRENT_DATE,
    'present'
);

-- 3. Test announcement notification (FIXED: Proper user targeting)
INSERT INTO announcements (school_id, title, content, target_audience, created_by)
VALUES (
    'your-school-uuid-here',
    'Test Announcement - System Fixed',
    'This is a test announcement to verify the FIXED notification system is working with proper concurrency safety.',
    'all',
    'admin-user-uuid-here'
);

-- 4. Test fee payment notification (FIXED: Proper payload structure)
INSERT INTO fee_payments (school_id, student_id, amount, payment_date, status)
VALUES (
    'your-school-uuid-here',
    'your-user-uuid-here',
    150.00,
    CURRENT_DATE,
    'paid'
);

-- 5. Test exam result notification (FIXED: Proper payload structure)
INSERT INTO exam_results (school_id, student_id, exam_id, marks, grade)
VALUES (
    'your-school-uuid-here',
    'your-user-uuid-here',
    'exam-uuid-here',
    85.5,
    'A'
);

-- 6. Test voice message notification (FIXED: Proper payload structure)
INSERT INTO voice_messages (school_id, sender_id, recipient_id, message_url, duration_seconds)
VALUES (
    'your-school-uuid-here',
    'sender-uuid-here',
    'your-user-uuid-here',
    'https://example.com/voice-message.mp3',
    30
);

-- 7. FIXED: Check notification queue with new fields
SELECT 
    id,
    event_type,
    title,
    body,
    processed,
    processing_started_at,
    processed_at,
    created_at,
    payload
FROM notification_queue 
ORDER BY created_at DESC 
LIMIT 10;

-- 8. FIXED: Check FCM tokens with new structure
SELECT 
    user_id,
    platform,
    is_active,
    LEFT(fcm_token, 20) || '...' as token_preview,
    created_at,
    updated_at,
    last_used_at
FROM user_fcm_tokens
ORDER BY updated_at DESC;

-- 9. FIXED: Manually queue a custom notification using new function
SELECT queue_notification(
    'your-school-uuid-here'::uuid,
    'your-user-uuid-here'::uuid,
    'test_notification',
    '🧪 Test Notification - System Fixed',
    'This is a manual test notification to verify the FIXED system is working with proper concurrency safety and reliability.',
    jsonb_build_object(
        'type', 'test_notification',
        'entity_id', gen_random_uuid()::text,
        'test', 'true',
        'timestamp', NOW()::text
    )
);

-- 10. FIXED: Check comprehensive queue statistics
SELECT * FROM get_queue_statistics();

-- 11. FIXED: Test concurrency-safe notification claiming (simulates worker)
SELECT * FROM claim_unprocessed_notifications(5, 'test-worker');

-- 12. FIXED: Test FCM token retrieval for a user
SELECT * FROM get_user_active_fcm_tokens('your-user-uuid-here'::uuid);

-- 13. FIXED: Test system health check
SELECT * FROM notification_system_health_check();

-- 14. Test deactivating invalid tokens (simulates FCM failure response)
-- First, get some token IDs
WITH token_ids AS (
    SELECT id FROM user_fcm_tokens 
    WHERE user_id = 'your-user-uuid-here'::uuid 
    LIMIT 1
)
SELECT deactivate_fcm_tokens(ARRAY(SELECT id FROM token_ids));

-- 15. Test cleanup functions
SELECT cleanup_old_notifications(1); -- Clean notifications older than 1 day (for testing)

-- 16. FIXED: Verify RLS policies are working (should fail for non-service-role)
-- This should fail if RLS is properly configured:
-- SELECT * FROM notification_queue; -- Should be blocked for regular users

-- 17. Performance test: Check indexes are working
EXPLAIN (ANALYZE, BUFFERS) 
SELECT * FROM notification_queue 
WHERE processed = FALSE 
ORDER BY created_at ASC 
LIMIT 50;

-- 18. Concurrency test: Simulate multiple workers claiming notifications
-- Run this multiple times simultaneously to test locking
SELECT 
    'worker-' || generate_random_uuid() as worker_id,
    COUNT(*) as claimed_notifications
FROM claim_unprocessed_notifications(10, 'concurrent-test-worker-' || generate_random_uuid())
GROUP BY 1;