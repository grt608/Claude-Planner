import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const TASKS = 'planner.tasks.v1';
const KEY = 'planner.apiKey';

export async function loadTasks() {
  try {
    const raw = await AsyncStorage.getItem(TASKS);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export const saveTasks = (tasks) => AsyncStorage.setItem(TASKS, JSON.stringify(tasks));

export const loadApiKey = () => SecureStore.getItemAsync(KEY).catch(() => null);
export const saveApiKey = (k) =>
  k ? SecureStore.setItemAsync(KEY, k) : SecureStore.deleteItemAsync(KEY);
