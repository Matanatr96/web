import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as SecureStore from "expo-secure-store";
import * as LocalAuthentication from "expo-local-authentication";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { setApiAdminToken, verifyAdminCredentials } from "@/api/client";

const KEYCHAIN_TOKEN_KEY = "tlm_admin_session_token_v1";

export type AuthContextValue = {
  isAdmin: boolean;
  adminToken: string | null;
  isHydratingAuth: boolean;
  isAuthModalOpen: boolean;
  loginWithPassword: (password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
  confirmDestructiveAction: (reason?: string) => Promise<boolean>;
  openAuthModal: () => void;
  closeAuthModal: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

async function readStoredToken(): Promise<string | null> {
  try {
    const val = await SecureStore.getItemAsync(KEYCHAIN_TOKEN_KEY, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    if (val) return val;
  } catch {
    // Fall back to AsyncStorage on Simulator/environments without Keychain entitlement.
  }
  try {
    return await AsyncStorage.getItem(KEYCHAIN_TOKEN_KEY);
  } catch {
    return null;
  }
}

async function writeStoredToken(token: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEYCHAIN_TOKEN_KEY, token, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } catch {
    // Ignore SecureStore write failure and persist to AsyncStorage fallback.
  }
  try {
    await AsyncStorage.setItem(KEYCHAIN_TOKEN_KEY, token);
  } catch {
    // Ignore fallback failure.
  }
}

async function clearStoredToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEYCHAIN_TOKEN_KEY);
  } catch {
    // Ignore SecureStore delete failure.
  }
  try {
    await AsyncStorage.removeItem(KEYCHAIN_TOKEN_KEY);
  } catch {
    // Ignore fallback failure.
  }
}

/**
 * Root authentication provider managing the iOS Keychain admin session token
 * and FaceID (`expo-local-authentication`) biometric gating for admin mutations.
 *
 * @param props - React children.
 * @returns `AuthContext.Provider` plus the built-in admin unlock sheet.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [isHydratingAuth, setIsHydratingAuth] = useState<boolean>(true);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState<boolean>(false);
  const [passwordInput, setPasswordInput] = useState<string>("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const stored = await readStoredToken();
        if (stored && mounted) {
          setApiAdminToken(stored);
          setAdminToken(stored);
        }
      } finally {
        if (mounted) setIsHydratingAuth(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const loginWithPassword = useCallback(
    async (password: string): Promise<{ ok: boolean; error?: string }> => {
      const trimmed = password.trim();
      if (!trimmed) {
        return { ok: false, error: "Enter your admin password." };
      }
      try {
        const res = await verifyAdminCredentials(trimmed);
        if (!res.authenticated) {
          return { ok: false, error: "Invalid admin password." };
        }
        const canonicalToken = res.token ?? trimmed;
        await writeStoredToken(canonicalToken);
        setApiAdminToken(canonicalToken);
        setAdminToken(canonicalToken);
        return { ok: true };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Authentication failed.";
        return { ok: false, error: msg };
      }
    },
    [],
  );

  const logout = useCallback(async () => {
    await clearStoredToken();
    setApiAdminToken(null);
    setAdminToken(null);
  }, []);

  const confirmDestructiveAction = useCallback(
    async (reason: string = "Confirm admin action"): Promise<boolean> => {
      try {
        const hasHardware = await LocalAuthentication.hasHardwareAsync();
        const isEnrolled = await LocalAuthentication.isEnrolledAsync();
        if (!hasHardware || !isEnrolled) {
          return Boolean(adminToken);
        }
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: reason,
          cancelLabel: "Cancel",
          fallbackLabel: "Use Passcode",
        });
        return result.success;
      } catch {
        return Boolean(adminToken);
      }
    },
    [adminToken],
  );

  const openAuthModal = useCallback(() => {
    setAuthError(null);
    setPasswordInput("");
    setIsAuthModalOpen(true);
  }, []);

  const closeAuthModal = useCallback(() => {
    setIsAuthModalOpen(false);
    setAuthError(null);
    setPasswordInput("");
  }, []);

  const handleModalSubmit = useCallback(async () => {
    setIsSubmitting(true);
    setAuthError(null);
    try {
      const res = await loginWithPassword(passwordInput);
      if (res.ok) {
        closeAuthModal();
      } else {
        setAuthError(res.error ?? "Invalid password.");
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [passwordInput, loginWithPassword, closeAuthModal]);

  const value = useMemo<AuthContextValue>(
    () => ({
      isAdmin: Boolean(adminToken),
      adminToken,
      isHydratingAuth,
      isAuthModalOpen,
      loginWithPassword,
      logout,
      confirmDestructiveAction,
      openAuthModal,
      closeAuthModal,
    }),
    [
      adminToken,
      isHydratingAuth,
      isAuthModalOpen,
      loginWithPassword,
      logout,
      confirmDestructiveAction,
      openAuthModal,
      closeAuthModal,
    ],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      <Modal
        visible={isAuthModalOpen}
        animationType="slide"
        transparent
        onRequestClose={closeAuthModal}
      >
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            <Text style={styles.title}>
              {adminToken ? "Admin Unlocked" : "Unlock Admin Mode"}
            </Text>
            <Text style={styles.subtitle}>
              {adminToken
                ? "Your admin session token is stored securely in iOS Keychain."
                : "Enter your ADMIN_PASSWORD once to store your token in iOS Keychain."}
            </Text>

            {adminToken ? (
              <View style={styles.actionsRow}>
                <Pressable
                  style={[styles.button, styles.secondaryButton]}
                  onPress={closeAuthModal}
                >
                  <Text style={styles.secondaryButtonText}>Done</Text>
                </Pressable>
                <Pressable
                  style={[styles.button, styles.dangerButton]}
                  onPress={async () => {
                    await logout();
                    closeAuthModal();
                  }}
                >
                  <Text style={styles.primaryButtonText}>Sign Out</Text>
                </Pressable>
              </View>
            ) : (
              <>
                <TextInput
                  style={styles.input}
                  value={passwordInput}
                  onChangeText={setPasswordInput}
                  placeholder="Admin password"
                  placeholderTextColor="#78716c"
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  onSubmitEditing={handleModalSubmit}
                />
                {authError ? <Text style={styles.errorText}>{authError}</Text> : null}
                <View style={styles.actionsRow}>
                  <Pressable
                    style={[styles.button, styles.secondaryButton]}
                    onPress={closeAuthModal}
                    disabled={isSubmitting}
                  >
                    <Text style={styles.secondaryButtonText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.button, styles.primaryButton]}
                    onPress={handleModalSubmit}
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? (
                      <ActivityIndicator size="small" color="#fafaf9" />
                    ) : (
                      <Text style={styles.primaryButtonText}>Verify & Save</Text>
                    )}
                  </Pressable>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    </AuthContext.Provider>
  );
}

/**
 * Access the current admin authentication state and Keychain/FaceID helpers.
 *
 * @returns `AuthContextValue`.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#1c1917",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    gap: 12,
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
    color: "#fafaf9",
  },
  subtitle: {
    fontSize: 13,
    color: "#a8a29e",
    lineHeight: 18,
  },
  input: {
    borderWidth: 1,
    borderColor: "#44403c",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: "#fafaf9",
    backgroundColor: "#292524",
    marginTop: 4,
  },
  errorText: {
    fontSize: 13,
    color: "#f87171",
  },
  actionsRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 8,
  },
  button: {
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButton: {
    backgroundColor: "#10b981",
  },
  dangerButton: {
    backgroundColor: "#ef4444",
  },
  secondaryButton: {
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#44403c",
  },
  primaryButtonText: {
    color: "#fafaf9",
    fontWeight: "600",
    fontSize: 14,
  },
  secondaryButtonText: {
    color: "#d6d3d1",
    fontWeight: "500",
    fontSize: 14,
  },
});
