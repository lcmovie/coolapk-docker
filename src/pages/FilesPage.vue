<template>
  <div class="files-page custom-scrollbar">
    <div class="files-heading"><h2>NAS 保存的文件</h2><AppButton variant="secondary" size="sm" :loading="loading" @click="loadFiles">刷新</AppButton></div>
    <p>下载与导出文件保存在安装目录的 data 下。点击文件可下载到当前设备。</p>
    <p v-if="error" class="files-error" role="alert">{{ error }}</p>
    <p v-else-if="!files.length && !loading">暂无保存的下载或导出文件。</p>
    <a v-for="file in files" :key="file.path" class="file-row" :href="file.url" :download="file.name">
      <i class="fas fa-file-arrow-down"></i><span><strong>{{ file.name }}</strong><small>{{ file.path }}</small></span><small>{{ formatSize(file.size) }}</small>
    </a>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { apiRequest } from '../utils/runtime';
import AppButton from '../components/common/AppButton.vue';
type SavedFile = { name: string; path: string; url: string; size: number };
const files = ref<SavedFile[]>([]);
const loading = ref(false);
const error = ref('');
function formatSize(size: number) { return size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.ceil(size / 1024)} KB`; }
async function loadFiles() {
  loading.value = true;
  error.value = '';
  try { files.value = (await apiRequest<{ files: SavedFile[] }>('/api/files')).files; }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '读取文件失败'; }
  finally { loading.value = false; }
}
onMounted(loadFiles);
</script>

<style scoped>
.files-page { flex: 1; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 16px; }
.files-heading { display: flex; justify-content: space-between; align-items: center; }
p, small { color: var(--text-secondary); font-size: 13px; }
.file-row { padding: 14px 16px; display: flex; gap: 14px; align-items: center; border: 1px solid var(--border); border-radius: var(--radius-card); background: var(--surface); }
.file-row span { flex: 1; display: flex; flex-direction: column; gap: 4px; overflow-wrap: anywhere; }
.file-row strong { font-size: 14px; }
.files-error { color: var(--danger); }
</style>
