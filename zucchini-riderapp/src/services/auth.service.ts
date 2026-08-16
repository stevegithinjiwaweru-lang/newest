import AsyncStorage from "@react-native-async-storage/async-storage";
import client from "../api/client";
import { endpoints } from "../api/endpoints";

export interface RiderUser {
  id: string;
  name: string;
  phone: string;
  role: string;
  riderId?: string | null;
}

interface LoginResponse {
  ok: boolean;
  accessToken: string;
  refreshToken: string;
  user: RiderUser;
}

export const login = async (phone: string, password: string): Promise<RiderUser> => {
  // Prefer dedicated rider route (same handler server-side); falls back if needed
  let data: LoginResponse;
  try {
    const res = await client.post<LoginResponse>(endpoints.auth.riderLogin, { phone, password });
    data = res.data;
  } catch {
    const res = await client.post<LoginResponse>(endpoints.auth.login, { phone, password });
    data = res.data;
  }
  if (!data?.ok) throw new Error("Login failed");
  if (data.user?.role && data.user.role !== "RIDER") {
    throw new Error("This account is not a rider. Use the dispatcher dashboard instead.");
  }
  if (!data.user?.riderId) {
    throw new Error("Rider account is not linked to a rider profile. Contact dispatch.");
  }

  await AsyncStorage.setItem("accessToken", data.accessToken);
  await AsyncStorage.setItem("refreshToken", data.refreshToken);
  await AsyncStorage.setItem("user", JSON.stringify(data.user));

  return data.user;
};

export const getStoredUser = async (): Promise<RiderUser | null> => {
  const raw = await AsyncStorage.getItem("user");
  return raw ? JSON.parse(raw) : null;
};

export const logout = async (): Promise<void> => {
  await AsyncStorage.multiRemove(["accessToken", "refreshToken", "user"]);
};
