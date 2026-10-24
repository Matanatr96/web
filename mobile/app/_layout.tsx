import React from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "@/auth/AuthContext";
import { RestaurantsProvider } from "@/store/RestaurantsContext";
import RestaurantDetailSheet from "@/components/RestaurantDetailSheet";
import AddRateVisitSheet from "@/components/AddRateVisitSheet";
import ReceiptSplitSheet from "@/components/ReceiptSplitSheet";

/**
 * Root Expo Router layout wrapping the 3-tab shell (`(tabs)`) inside
 * `SafeAreaProvider`, `AuthProvider` (iOS Keychain + FaceID), and
 * `RestaurantsProvider` (MMKV cold-start cache + Supabase sync), while mounting
 * the three global modal sheets at the top level for seamless cross-tab handoffs.
 */
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <RestaurantsProvider>
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: "#0c0a09" },
            }}
          >
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          </Stack>
          <RestaurantDetailSheet />
          <AddRateVisitSheet />
          <ReceiptSplitSheet />
        </RestaurantsProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
