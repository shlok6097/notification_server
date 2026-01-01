/**
 * FIXED: Client-side FCM token management
 * 
 * This code should be integrated into your React Native / Flutter app
 * to register and update FCM tokens in the database.
 * 
 * CHANGES:
 * - Multiple tokens per user allowed
 * - Proper upsert logic using (user_id, fcm_token) constraint
 * - is_active field management
 * - Better error handling
 */

// React Native example using @react-native-firebase/messaging
import messaging from '@react-native-firebase/messaging';
import { supabase } from './supabase-client';
import { Platform } from 'react-native';

class FCMTokenManager {
  constructor(userId, schoolId) {
    this.userId = userId;
    this.schoolId = schoolId;
  }

  /**
   * FIXED: Initialize FCM and register token with proper error handling
   */
  async initialize() {
    try {
      // Request permission (iOS)
      const authStatus = await messaging().requestPermission();
      const enabled = 
        authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
        authStatus === messaging.AuthorizationStatus.PROVISIONAL;

      if (!enabled) {
        console.log('FCM permission denied');
        return;
      }

      // Get FCM token
      const fcmToken = await messaging().getToken();
      
      if (fcmToken) {
        await this.updateToken(fcmToken);
        console.log('FCM token registered:', fcmToken.substring(0, 20) + '...');
      }

      // Listen for token refresh
      messaging().onTokenRefresh(async (newToken) => {
        await this.updateToken(newToken);
        console.log('FCM token refreshed:', newToken.substring(0, 20) + '...');
      });

      // Handle foreground messages
      messaging().onMessage(async (remoteMessage) => {
        console.log('Foreground message:', remoteMessage);
        this.handleNotification(remoteMessage, 'foreground');
      });

      // Handle background/quit messages
      messaging().setBackgroundMessageHandler(async (remoteMessage) => {
        console.log('Background message:', remoteMessage);
        this.handleNotification(remoteMessage, 'background');
      });

      // Handle notification opened app
      messaging().onNotificationOpenedApp(remoteMessage => {
        console.log('Notification opened app:', remoteMessage);
        this.handleNotificationTap(remoteMessage);
      });

      // Check if app was opened from a notification
      const initialNotification = await messaging().getInitialNotification();
      if (initialNotification) {
        console.log('App opened from notification:', initialNotification);
        this.handleNotificationTap(initialNotification);
      }

    } catch (error) {
      console.error('FCM initialization error:', error);
    }
  }

  /**
   * FIXED: Update FCM token in database with proper upsert
   */
  async updateToken(fcmToken) {
    try {
      const { error } = await supabase
        .from('user_fcm_tokens')
        .upsert({
          user_id: this.userId,
          school_id: this.schoolId,
          fcm_token: fcmToken,
          platform: Platform.OS, // 'android' or 'ios'
          is_active: true,
          updated_at: new Date().toISOString(),
          last_used_at: new Date().toISOString(),
        }, {
          onConflict: 'user_id,fcm_token'
        });

      if (error) {
        console.error('Failed to update FCM token:', error);
      } else {
        console.log('FCM token updated successfully');
      }
    } catch (error) {
      console.error('Database error updating FCM token:', error);
    }
  }

  /**
   * FIXED: Remove FCM token (on logout) - mark as inactive instead of deleting
   */
  async deactivateToken() {
    try {
      const fcmToken = await messaging().getToken();
      
      const { error } = await supabase
        .from('user_fcm_tokens')
        .update({ 
          is_active: false,
          updated_at: new Date().toISOString()
        })
        .eq('user_id', this.userId)
        .eq('fcm_token', fcmToken);

      if (error) {
        console.error('Failed to deactivate FCM token:', error);
      } else {
        console.log('FCM token deactivated successfully');
      }
    } catch (error) {
      console.error('Error deactivating FCM token:', error);
    }
  }

  /**
   * FIXED: Handle incoming notifications with proper navigation
   */
  handleNotification(remoteMessage, context) {
    const { notification, data } = remoteMessage;
    
    console.log(`Notification received in ${context}:`, {
      title: notification?.title,
      body: notification?.body,
      type: data?.type,
      entity_id: data?.entity_id
    });

    // Show local notification if in foreground
    if (context === 'foreground') {
      // Use your preferred local notification library
      // e.g., react-native-push-notification
    }
  }

  /**
   * FIXED: Handle notification tap with proper navigation
   */
  handleNotificationTap(remoteMessage) {
    const { data } = remoteMessage;
    
    if (!data?.type) {
      console.log('No navigation data in notification');
      return;
    }

    // Navigate based on notification type
    switch (data.type) {
      case 'attendance_marked':
        this.navigateToAttendance(data.entity_id);
        break;
      case 'announcement_created':
        this.navigateToAnnouncement(data.entity_id);
        break;
      case 'fee_payment_processed':
        this.navigateToPayment(data.entity_id);
        break;
      case 'result_published':
        this.navigateToResult(data.entity_id);
        break;
      case 'voice_message_received':
        this.navigateToVoiceMessage(data.entity_id);
        break;
      default:
        console.log('Unknown notification type:', data.type);
    }
  }

  // Navigation helpers (implement based on your navigation library)
  navigateToAttendance(attendanceId) {
    // Navigate to attendance screen
    console.log('Navigate to attendance:', attendanceId);
  }

  navigateToAnnouncement(announcementId) {
    // Navigate to announcement screen
    console.log('Navigate to announcement:', announcementId);
  }

  navigateToPayment(paymentId) {
    // Navigate to payment screen
    console.log('Navigate to payment:', paymentId);
  }

  navigateToResult(resultId) {
    // Navigate to result screen
    console.log('Navigate to result:', resultId);
  }

  navigateToVoiceMessage(messageId) {
    // Navigate to voice message screen
    console.log('Navigate to voice message:', messageId);
  }
}

// Usage in your app
export const initializeFCM = (userId, schoolId) => {
  const fcmManager = new FCMTokenManager(userId, schoolId);
  fcmManager.initialize();
  return fcmManager;
};

// FIXED: Flutter/Dart equivalent
/*
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

class FCMTokenManager {
  final String userId;
  final String schoolId;
  
  FCMTokenManager(this.userId, this.schoolId);
  
  Future<void> initialize() async {
    FirebaseMessaging messaging = FirebaseMessaging.instance;
    
    // Request permission
    NotificationSettings settings = await messaging.requestPermission();
    
    if (settings.authorizationStatus == AuthorizationStatus.authorized) {
      // Get token
      String? token = await messaging.getToken();
      
      if (token != null) {
        await updateToken(token);
      }
      
      // Listen for token refresh
      messaging.onTokenRefresh.listen(updateToken);
      
      // Handle messages
      FirebaseMessaging.onMessage.listen(handleForegroundMessage);
      FirebaseMessaging.onMessageOpenedApp.listen(handleNotificationTap);
      
      // Check initial message
      RemoteMessage? initialMessage = await messaging.getInitialMessage();
      if (initialMessage != null) {
        handleNotificationTap(initialMessage);
      }
    }
  }
  
  Future<void> updateToken(String fcmToken) async {
    await Supabase.instance.client
        .from('user_fcm_tokens')
        .upsert({
          'user_id': userId,
          'school_id': schoolId,
          'fcm_token': fcmToken,
          'platform': Platform.isAndroid ? 'android' : 'ios',
          'is_active': true,
          'updated_at': DateTime.now().toIso8601String(),
          'last_used_at': DateTime.now().toIso8601String(),
        });
  }
  
  Future<void> deactivateToken() async {
    String? token = await FirebaseMessaging.instance.getToken();
    if (token != null) {
      await Supabase.instance.client
          .from('user_fcm_tokens')
          .update({
            'is_active': false,
            'updated_at': DateTime.now().toIso8601String(),
          })
          .eq('user_id', userId)
          .eq('fcm_token', token);
    }
  }
  
  void handleForegroundMessage(RemoteMessage message) {
    print('Foreground message: ${message.notification?.title}');
    // Show local notification
  }
  
  void handleNotificationTap(RemoteMessage message) {
    String? type = message.data['type'];
    String? entityId = message.data['entity_id'];
    
    // Navigate based on type
    switch (type) {
      case 'attendance_marked':
        // Navigate to attendance
        break;
      case 'announcement_created':
        // Navigate to announcement
        break;
      // ... other cases
    }
  }
}
*/