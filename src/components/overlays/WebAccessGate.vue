<template>
  <main class="access-screen">
    <form class="access-card" @submit.prevent="submit">
      <img src="../../assets/coolapk-logo-rounded.png" alt="酷安" width="52" height="52" />
      <h1>{{ configured ? `打开${APP_DISPLAY_NAME}` : `设置${APP_DISPLAY_NAME}访问密码` }}</h1>
      <p>{{ configured ? '输入访问密码，继续使用保存在 NAS 上的酷安账号。' : '首次使用，请为网页设置访问密码。账号和设置将持久保存在 NAS 安装目录。' }}</p>
      <label for="access-password">{{ configured ? '访问密码' : '访问密码（至少 10 个字符）' }}</label>
      <input id="access-password" v-model="password" type="password" :autocomplete="configured ? 'current-password' : 'new-password'" :minlength="configured ? 1 : 10" required autofocus />
      <template v-if="!configured">
        <label for="access-confirm">再次输入密码</label>
        <input id="access-confirm" v-model="confirmPassword" type="password" autocomplete="new-password" required />
      </template>
      <p v-if="error" class="access-error" role="alert">{{ error }}</p>
      <button type="submit" :disabled="busy">{{ busy ? '正在验证…' : configured ? '打开网页' : '保存并打开网页' }}</button>
    </form>
  </main>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { apiRequest } from '../../utils/runtime';
import { APP_DISPLAY_NAME } from '../../constants/app';

const props = defineProps<{ configured: boolean; onReady: () => void }>();
const password = ref('');
const confirmPassword = ref('');
const error = ref('');
const busy = ref(false);
async function submit() {
  if (busy.value) return;
  error.value = '';
  if (!props.configured && password.value !== confirmPassword.value) { error.value = '两次输入的密码不一致'; return; }
  busy.value = true;
  try {
    await apiRequest(props.configured ? '/api/auth/login' : '/api/auth/setup', {
      method: 'POST', body: JSON.stringify({ password: password.value }),
    });
    password.value = '';
    confirmPassword.value = '';
    props.onReady();
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '验证失败，请重试'; }
  finally { busy.value = false; }
}
</script>

<style scoped>
.access-screen { height: 100%; display: grid; place-items: center; padding: 24px; background: var(--background); }
.access-card { width: min(100%, 420px); padding: 32px; display: flex; flex-direction: column; gap: 14px; border: 1px solid var(--border); background: var(--surface); border-radius: var(--radius-card); }
h1 { font-size: 23px; margin-top: 4px; color: var(--text-primary); }
p { font-size: 14px; line-height: 1.7; color: var(--text-secondary); }
label { font-size: 13px; }
input { width: 100%; padding: 11px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--background); }
input:focus { border-color: var(--brand-primary); }
button { padding: 12px; border-radius: 8px; background: var(--brand-primary); color: white; font-weight: 600; margin-top: 8px; }
button:disabled { opacity: .6; }
.access-error { color: var(--danger); }
</style>
