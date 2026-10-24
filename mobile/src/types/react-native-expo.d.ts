declare module "react-native" {
  import type React from "react";

  export type StyleProp<T> = T | T[] | null | undefined | false;
  export type ViewStyle = Record<string, unknown>;
  export type TextStyle = Record<string, unknown>;
  export type ImageStyle = Record<string, unknown>;
  export type ColorValue = string;

  export interface LayoutChangeEvent {
    nativeEvent: {
      layout: { x: number; y: number; width: number; height: number };
    };
  }

  export interface NativeScrollEvent {
    contentOffset: { x: number; y: number };
    contentSize: { width: number; height: number };
    layoutMeasurement: { width: number; height: number };
  }

  export interface NativeSyntheticEvent<T> {
    nativeEvent: T;
  }

  export interface GestureResponderEvent {
    nativeEvent: {
      locationX: number;
      locationY: number;
      pageX: number;
      pageY: number;
      timestamp: number;
    };
  }

  export interface ViewProps {
    style?: StyleProp<ViewStyle>;
    children?: React.ReactNode;
    onLayout?: (e: LayoutChangeEvent) => void;
    pointerEvents?: "box-none" | "none" | "box-only" | "auto";
    accessibilityLabel?: string;
    accessibilityRole?: string;
    testID?: string;
    [key: string]: unknown;
  }

  export interface TextProps {
    style?: StyleProp<TextStyle>;
    children?: React.ReactNode;
    numberOfLines?: number;
    ellipsizeMode?: "head" | "middle" | "tail" | "clip";
    selectable?: boolean;
    onPress?: () => void;
    testID?: string;
    [key: string]: unknown;
  }

  export interface TextInputProps {
    value?: string;
    defaultValue?: string;
    onChangeText?: (text: string) => void;
    onSubmitEditing?: () => void;
    onFocus?: () => void;
    onBlur?: () => void;
    placeholder?: string;
    placeholderTextColor?: string;
    secureTextEntry?: boolean;
    keyboardType?:
      | "default"
      | "numeric"
      | "decimal-pad"
      | "number-pad"
      | "email-address"
      | "url"
      | "web-search";
    returnKeyType?: "done" | "go" | "next" | "search" | "send";
    autoCapitalize?: "none" | "sentences" | "words" | "characters";
    autoCorrect?: boolean;
    autoFocus?: boolean;
    multiline?: boolean;
    numberOfLines?: number;
    editable?: boolean;
    maxLength?: number;
    clearButtonMode?: "never" | "while-editing" | "unless-editing" | "always";
    style?: StyleProp<TextStyle>;
    testID?: string;
    [key: string]: unknown;
  }

  export interface TouchableOpacityProps extends ViewProps {
    onPress?: (e?: GestureResponderEvent) => void;
    onLongPress?: (e?: GestureResponderEvent) => void;
    disabled?: boolean;
    activeOpacity?: number;
    hitSlop?: number | { top?: number; bottom?: number; left?: number; right?: number };
  }

  export interface PressableStateCallbackType {
    pressed: boolean;
  }

  export interface PressableProps extends Omit<ViewProps, "style" | "children"> {
    onPress?: (e?: GestureResponderEvent) => void;
    onLongPress?: (e?: GestureResponderEvent) => void;
    disabled?: boolean;
    hitSlop?: number | { top?: number; bottom?: number; left?: number; right?: number };
    style?:
      | StyleProp<ViewStyle>
      | ((state: PressableStateCallbackType) => StyleProp<ViewStyle>);
    children?:
      | React.ReactNode
      | ((state: PressableStateCallbackType) => React.ReactNode);
  }

  export interface ScrollViewProps extends ViewProps {
    horizontal?: boolean;
    showsHorizontalScrollIndicator?: boolean;
    showsVerticalScrollIndicator?: boolean;
    keyboardShouldPersistTaps?: "always" | "never" | "handled";
    contentContainerStyle?: StyleProp<ViewStyle>;
    refreshControl?: React.ReactElement;
    onScroll?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
    scrollEventThrottle?: number;
    bounces?: boolean;
  }

  export interface FlatListProps<ItemT> extends ScrollViewProps {
    data: readonly ItemT[] | null | undefined;
    renderItem: (info: { item: ItemT; index: number }) => React.ReactElement | null;
    keyExtractor?: (item: ItemT, index: number) => string;
    ListHeaderComponent?: React.ComponentType<unknown> | React.ReactElement | null;
    ListFooterComponent?: React.ComponentType<unknown> | React.ReactElement | null;
    ListEmptyComponent?: React.ComponentType<unknown> | React.ReactElement | null;
    ItemSeparatorComponent?: React.ComponentType<unknown> | null;
    initialNumToRender?: number;
    maxToRenderPerBatch?: number;
  }

  export interface ModalProps extends ViewProps {
    visible?: boolean;
    animationType?: "none" | "slide" | "fade";
    transparent?: boolean;
    presentationStyle?: "fullScreen" | "pageSheet" | "formSheet" | "overFullScreen";
    onRequestClose?: () => void;
    onDismiss?: () => void;
  }

  export interface ImageProps {
    source: { uri: string } | number;
    style?: StyleProp<ImageStyle>;
    resizeMode?: "cover" | "contain" | "stretch" | "repeat" | "center";
    accessibilityLabel?: string;
    [key: string]: unknown;
  }

  export interface ActivityIndicatorProps extends ViewProps {
    size?: "small" | "large" | number;
    color?: string;
    animating?: boolean;
  }

  export interface SwitchProps extends ViewProps {
    value?: boolean;
    onValueChange?: (value: boolean) => void;
    disabled?: boolean;
    trackColor?: { false?: string; true?: string };
    thumbColor?: string;
  }

  export interface RefreshControlProps {
    refreshing: boolean;
    onRefresh?: () => void;
    tintColor?: string;
  }

  export interface KeyboardAvoidingViewProps extends ViewProps {
    behavior?: "height" | "position" | "padding";
    keyboardVerticalOffset?: number;
  }

  export class View extends React.Component<ViewProps> {}
  export class SafeAreaView extends React.Component<ViewProps> {}
  export class Text extends React.Component<TextProps> {}
  export class TextInput extends React.Component<TextInputProps> {
    focus(): void;
    blur(): void;
    clear(): void;
  }
  export class TouchableOpacity extends React.Component<TouchableOpacityProps> {}
  export class Pressable extends React.Component<PressableProps> {}
  export class ScrollView extends React.Component<ScrollViewProps> {
    scrollTo(opts: { x?: number; y?: number; animated?: boolean }): void;
    scrollToEnd(opts?: { animated?: boolean }): void;
  }
  export class FlatList<ItemT = unknown> extends React.Component<FlatListProps<ItemT>> {
    scrollToOffset(opts: { offset: number; animated?: boolean }): void;
    scrollToIndex(opts: { index: number; animated?: boolean }): void;
  }
  export class Modal extends React.Component<ModalProps> {}
  export class Image extends React.Component<ImageProps> {}
  export class ActivityIndicator extends React.Component<ActivityIndicatorProps> {}
  export class Switch extends React.Component<SwitchProps> {}
  export class RefreshControl extends React.Component<RefreshControlProps> {}
  export class KeyboardAvoidingView extends React.Component<KeyboardAvoidingViewProps> {}

  export const StyleSheet: {
    create<T extends Record<string, ViewStyle | TextStyle | ImageStyle>>(styles: T): T;
    flatten<T>(style?: StyleProp<T>): T;
    hairlineWidth: number;
    absoluteFillObject: ViewStyle;
    absoluteFill: ViewStyle;
  };

  export const Platform: {
    OS: "ios" | "android" | "web";
    Version: string | number;
    select<T>(specifics: { ios?: T; android?: T; web?: T; default?: T }): T | undefined;
  };

  export const Dimensions: {
    get(dim: "window" | "screen"): { width: number; height: number; scale: number; fontScale: number };
  };

  export function useWindowDimensions(): {
    width: number;
    height: number;
    scale: number;
    fontScale: number;
  };

  export function useColorScheme(): "light" | "dark" | null | undefined;

  export const Linking: {
    openURL(url: string): Promise<void>;
    canOpenURL(url: string): Promise<boolean>;
  };

  export const Share: {
    share(
      content: { title?: string; message?: string; url?: string },
      options?: { dialogTitle?: string; subject?: string },
    ): Promise<{ action: string; activityType?: string }>;
  };

  export interface AlertButton {
    text?: string;
    onPress?: (value?: string) => void;
    style?: "default" | "cancel" | "destructive";
  }

  export const Alert: {
    alert(
      title: string,
      message?: string,
      buttons?: AlertButton[],
      options?: { cancelable?: boolean },
    ): void;
    prompt(
      title: string,
      message?: string,
      callbackOrButtons?: ((text: string) => void) | AlertButton[],
      type?: "default" | "plain-text" | "secure-text" | "login-password",
      defaultValue?: string,
      keyboardType?: string,
    ): void;
  };

  export const Keyboard: {
    dismiss(): void;
  };

  export const Animated: {
    Value: new (val: number) => {
      setValue(val: number): void;
      interpolate(config: {
        inputRange: number[];
        outputRange: number[] | string[];
        extrapolate?: "extend" | "clamp" | "identity";
      }): unknown;
    };
    View: React.ComponentType<ViewProps>;
    Text: React.ComponentType<TextProps>;
    ScrollView: React.ComponentType<ScrollViewProps>;
    timing(
      value: unknown,
      config: { toValue: number; duration?: number; useNativeDriver?: boolean },
    ): { start(cb?: (result: { finished: boolean }) => void): void };
    spring(
      value: unknown,
      config: {
        toValue: number;
        damping?: number;
        stiffness?: number;
        mass?: number;
        tension?: number;
        friction?: number;
        useNativeDriver?: boolean;
      },
    ): { start(cb?: (result: { finished: boolean }) => void): void };
  };

  export const PanResponder: {
    create(config: Record<string, unknown>): {
      panHandlers: Record<string, unknown>;
    };
  };
}

declare module "expo-router" {
  import type React from "react";

  export interface ScreenProps {
    name?: string;
    options?: Record<string, unknown>;
  }

  export const Stack: React.ComponentType<{
    screenOptions?: Record<string, unknown>;
    children?: React.ReactNode;
  }> & {
    Screen: React.ComponentType<ScreenProps>;
  };

  export const Tabs: React.ComponentType<{
    screenOptions?: Record<string, unknown>;
    children?: React.ReactNode;
  }> & {
    Screen: React.ComponentType<ScreenProps>;
  };

  export function useRouter(): {
    push: (href: string) => void;
    replace: (href: string) => void;
    back: () => void;
    canGoBack: () => boolean;
  };

  export function useLocalSearchParams<T extends Record<string, string | string[]> = Record<string, string>>(): T;
  export function useSegments(): string[];
  export function usePathname(): string;
  export const Link: React.ComponentType<{
    href: string;
    asChild?: boolean;
    children?: React.ReactNode;
    style?: unknown;
  }>;
}

declare module "expo-secure-store" {
  export const WHEN_UNLOCKED_THIS_DEVICE_ONLY: number;
  export interface SecureStoreOptions {
    keychainAccessible?: number;
    requireAuthentication?: boolean;
    authenticationPrompt?: string;
  }
  export function getItemAsync(key: string, options?: SecureStoreOptions): Promise<string | null>;
  export function setItemAsync(key: string, value: string, options?: SecureStoreOptions): Promise<void>;
  export function deleteItemAsync(key: string, options?: SecureStoreOptions): Promise<void>;
}

declare module "expo-local-authentication" {
  export interface LocalAuthenticationOptions {
    promptMessage?: string;
    cancelLabel?: string;
    fallbackLabel?: string;
    disableDeviceFallback?: boolean;
  }
  export interface LocalAuthenticationResult {
    success: boolean;
    error?: string;
    warning?: string;
  }
  export function hasHardwareAsync(): Promise<boolean>;
  export function isEnrolledAsync(): Promise<boolean>;
  export function authenticateAsync(
    options?: LocalAuthenticationOptions,
  ): Promise<LocalAuthenticationResult>;
}

declare module "expo-location" {
  export enum Accuracy {
    Lowest = 1,
    Low = 2,
    Balanced = 3,
    High = 4,
    Highest = 5,
    BestForNavigation = 6,
  }
  export interface LocationObject {
    coords: {
      latitude: number;
      longitude: number;
      altitude: number | null;
      accuracy: number | null;
      speed: number | null;
      heading: number | null;
    };
    timestamp: number;
  }
  export function requestForegroundPermissionsAsync(): Promise<{
    status: "granted" | "denied" | "undetermined";
    granted: boolean;
  }>;
  export function getForegroundPermissionsAsync(): Promise<{
    status: "granted" | "denied" | "undetermined";
    granted: boolean;
  }>;
  export function getCurrentPositionAsync(options?: {
    accuracy?: Accuracy;
  }): Promise<LocationObject>;
}

declare module "expo-image-picker" {
  export interface ImagePickerAsset {
    uri: string;
    width: number;
    height: number;
    base64?: string | null;
    mimeType?: string;
    fileName?: string | null;
    fileSize?: number;
  }
  export interface ImagePickerResult {
    canceled: boolean;
    assets: ImagePickerAsset[] | null;
  }
  export interface ImagePickerOptions {
    mediaTypes?: "images" | "videos" | "all" | string[];
    allowsEditing?: boolean;
    allowsMultipleSelection?: boolean;
    quality?: number;
    base64?: boolean;
    selectionLimit?: number;
  }
  export function requestCameraPermissionsAsync(): Promise<{ status: string; granted: boolean }>;
  export function requestMediaLibraryPermissionsAsync(): Promise<{ status: string; granted: boolean }>;
  export function launchCameraAsync(options?: ImagePickerOptions): Promise<ImagePickerResult>;
  export function launchImageLibraryAsync(options?: ImagePickerOptions): Promise<ImagePickerResult>;
}

declare module "expo-image-manipulator" {
  export enum SaveFormat {
    JPEG = "jpeg",
    PNG = "png",
    WEBP = "webp",
  }
  export type Action =
    | { resize: { width?: number; height?: number } }
    | { rotate: number }
    | { crop: { originX: number; originY: number; width: number; height: number } };
  export interface SaveOptions {
    compress?: number;
    format?: SaveFormat;
    base64?: boolean;
  }
  export interface ImageResult {
    uri: string;
    width: number;
    height: number;
    base64?: string;
  }
  export function manipulateAsync(
    uri: string,
    actions: Action[],
    saveOptions?: SaveOptions,
  ): Promise<ImageResult>;
}

declare module "expo-haptics" {
  export enum ImpactFeedbackStyle {
    Light = "light",
    Medium = "medium",
    Heavy = "heavy",
    Soft = "soft",
    Rigid = "rigid",
  }
  export enum NotificationFeedbackType {
    Success = "success",
    Warning = "warning",
    Error = "error",
  }
  export function selectionAsync(): Promise<void>;
  export function impactAsync(style?: ImpactFeedbackStyle): Promise<void>;
  export function notificationAsync(type?: NotificationFeedbackType): Promise<void>;
}

declare module "expo-clipboard" {
  export function setStringAsync(text: string): Promise<boolean>;
  export function getStringAsync(): Promise<string>;
}

declare module "expo-sharing" {
  export function isAvailableAsync(): Promise<boolean>;
  export function shareAsync(
    url: string,
    options?: { mimeType?: string; dialogTitle?: string; UTI?: string },
  ): Promise<void>;
}

declare module "expo-status-bar" {
  import type React from "react";
  export const StatusBar: React.ComponentType<{
    style?: "auto" | "inverted" | "light" | "dark";
    backgroundColor?: string;
    translucent?: boolean;
  }>;
}

declare module "react-native-maps" {
  import type React from "react";
  import type { ViewProps } from "react-native";

  export interface LatLng {
    latitude: number;
    longitude: number;
  }

  export interface Region extends LatLng {
    latitudeDelta: number;
    longitudeDelta: number;
  }

  export interface MapViewProps extends ViewProps {
    initialRegion?: Region;
    region?: Region;
    onRegionChange?: (region: Region) => void;
    onRegionChangeComplete?: (region: Region) => void;
    showsUserLocation?: boolean;
    showsMyLocationButton?: boolean;
    showsPointsOfInterest?: boolean;
    showsCompass?: boolean;
    userInterfaceStyle?: "light" | "dark";
    mapPadding?: { top: number; right: number; bottom: number; left: number };
    onPress?: (e: { nativeEvent: { coordinate: LatLng } }) => void;
  }

  export interface MapMarkerProps extends ViewProps {
    coordinate: LatLng;
    title?: string;
    description?: string;
    pinColor?: string;
    onPress?: () => void;
    tracksViewChanges?: boolean;
    zIndex?: number;
  }

  export class Marker extends React.Component<MapMarkerProps> {}
  export class Callout extends React.Component<ViewProps & { onPress?: () => void }> {}

  export default class MapView extends React.Component<MapViewProps> {
    animateToRegion(region: Region, duration?: number): void;
    fitToCoordinates(
      coordinates: LatLng[],
      options?: {
        edgePadding?: { top: number; right: number; bottom: number; left: number };
        animated?: boolean;
      },
    ): void;
  }
}

declare module "react-native-mmkv" {
  export class MMKV {
    constructor(config?: { id?: string; encryptionKey?: string });
    set(key: string, value: boolean | string | number): void;
    getString(key: string): string | undefined;
    getNumber(key: string): number | undefined;
    getBoolean(key: string): boolean | undefined;
    delete(key: string): void;
    getAllKeys(): string[];
    clearAll(): void;
  }
}

declare module "@react-native-async-storage/async-storage" {
  const AsyncStorage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
    multiGet(keys: readonly string[]): Promise<readonly [string, string | null][]>;
  };
  export default AsyncStorage;
}

declare module "react-native-safe-area-context" {
  import type React from "react";
  import type { ViewProps } from "react-native";
  export const SafeAreaProvider: React.ComponentType<{ children?: React.ReactNode }>;
  export const SafeAreaView: React.ComponentType<
    ViewProps & { edges?: ("top" | "right" | "bottom" | "left")[] }
  >;
  export function useSafeAreaInsets(): {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
}

declare module "@expo/vector-icons" {
  import type React from "react";
  export interface IconProps {
    name: string;
    size?: number;
    color?: string;
    style?: unknown;
  }
  export const Ionicons: React.ComponentType<IconProps>;
  export const Feather: React.ComponentType<IconProps>;
  export const MaterialCommunityIcons: React.ComponentType<IconProps>;
}
