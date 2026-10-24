import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/auth/AuthContext";
import { useRestaurants } from "@/store/RestaurantsContext";

/**
 * 3-Tab iPhone navigation layout (`Explore`, `Decide`, `Receipts`) with
 * persistent header controls for Admin/FaceID unlock, quick restaurant/visit
 * logging (`+ Rate`), and instant receipt scanning (`📷`).
 */
export default function TabsLayout() {
  const { isAdmin, openAuthModal } = useAuth();
  const { openAddRateSheet, openReceiptSplitSheet } = useRestaurants();

  return (
    <Tabs
      screenOptions={{
        headerStyle: {
          backgroundColor: "#1c1917",
        },
        headerTitleStyle: {
          color: "#fafaf9",
          fontWeight: "700",
          fontSize: 17,
        },
        headerShadowVisible: false,
        tabBarStyle: {
          backgroundColor: "#1c1917",
          borderTopColor: "#292524",
          height: 84,
          paddingBottom: 24,
          paddingTop: 8,
        },
        tabBarActiveTintColor: "#10b981",
        tabBarInactiveTintColor: "#78716c",
        headerRight: () => (
          <View style={styles.headerRight}>
            <Pressable
              onPress={() => openReceiptSplitSheet()}
              style={styles.iconPill}
              accessibilityLabel="Scan Receipt"
            >
              <Text style={styles.pillText}>📷 Split</Text>
            </Pressable>
            <Pressable
              onPress={() => openAddRateSheet()}
              style={[styles.iconPill, styles.primaryPill]}
              accessibilityLabel="Add or Rate Restaurant"
            >
              <Text style={styles.primaryPillText}>+ Rate</Text>
            </Pressable>
            <Pressable
              onPress={openAuthModal}
              style={styles.lockButton}
              accessibilityLabel={isAdmin ? "Admin Unlocked" : "Unlock Admin"}
            >
              <Ionicons
                name={isAdmin ? "lock-open" : "lock-closed-outline"}
                size={18}
                color={isAdmin ? "#10b981" : "#a8a29e"}
              />
            </Pressable>
          </View>
        ),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Explore",
          tabBarIcon: ({ color, size }: { color: string; size: number }) => (
            <Ionicons name="map-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="decide"
        options={{
          title: "Decide",
          tabBarIcon: ({ color, size }: { color: string; size: number }) => (
            <Ionicons name="sparkles-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="receipts"
        options={{
          title: "Receipts",
          tabBarIcon: ({ color, size }: { color: string; size: number }) => (
            <Ionicons name="receipt-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginRight: 14,
  },
  iconPill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#44403c",
  },
  primaryPill: {
    backgroundColor: "#059669",
    borderColor: "#10b981",
  },
  pillText: {
    color: "#e7e5e4",
    fontSize: 12,
    fontWeight: "600",
  },
  primaryPillText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "700",
  },
  lockButton: {
    padding: 6,
    borderRadius: 999,
    backgroundColor: "#292524",
  },
});
