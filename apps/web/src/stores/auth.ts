import { create } from 'zustand';
import type { UserDto } from '@matcheck/contracts';

type AuthState = {
  accessToken: string | null;
  user: UserDto | null;
  setAccessToken: (token: string | null) => void;
  setUser: (user: UserDto | null) => void;
  setAuth: (token: string, user: UserDto) => void;
  clear: () => void;
};

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  user: null,
  setAccessToken: (accessToken) => set({ accessToken }),
  setUser: (user) => set({ user }),
  setAuth: (accessToken, user) => set({ accessToken, user }),
  clear: () => set({ accessToken: null, user: null }),
}));
