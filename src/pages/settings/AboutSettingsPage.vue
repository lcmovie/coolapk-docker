<template>
  <div class="settings-section">
    <h3 class="section-title">关于{{ APP_DISPLAY_NAME }}</h3>

    <!-- 应用信息 -->
    <div class="setting-group">
      <div class="about-head">
        <img src="../../assets/coolapk-logo-rounded.png" alt="酷安 Logo" class="about-logo" />
        <div class="about-info">
          <div class="about-name-row">
            <span class="about-name">{{ APP_DISPLAY_NAME }}</span>
            <span class="about-version">v{{ appVersion }}</span>
            <span class="about-channel">{{ channelLabel }}</span>
          </div>
          <p class="about-desc">
            基于 Vue 3 与 Rust 构建的第三方非官方酷安 Docker 客户端，使用原生网页呈现内容，支持 Docker / Compose 部署。
          </p>
        </div>
        <AppButton variant="secondary" size="sm" icon="fas fa-sync-alt" @click="checkUpdate">
          检查更新
        </AppButton>
      </div>

      <div class="setting-row tech-row">
        <div class="row-info">
          <span class="row-label">技术栈</span>
          <span class="row-sub">{{ techStack.join(' · ') }}</span>
        </div>
        <div class="tech-badges">
          <span v-for="t in techStack" :key="t" class="tech-badge">{{ t }}</span>
        </div>
      </div>

      <div class="setting-row">
        <div class="row-info">
          <span class="row-label">社区数据</span>
          <span class="row-sub">Stars · Forks · Issues</span>
        </div>
        <div class="repo-stats">
          <span class="repo-stat" title="Stars"><i class="fas fa-star"></i> 0</span>
          <span class="repo-stat" title="Forks"><i class="fas fa-code-branch"></i> 0</span>
          <span class="repo-stat" title="Issues"><i class="fas fa-exclamation-circle"></i> 0</span>
        </div>
      </div>

      <div class="setting-row">
        <div class="row-info">
          <span class="row-label">开源协议</span>
          <span class="row-sub">MIT License · 第三方非官方 Docker 客户端</span>
        </div>
        <span class="license-badge">MIT</span>
      </div>
    </div>

    <!-- 联系与支持 -->
    <div class="setting-group">
      <h4 class="group-title">联系与支持</h4>
      <div class="setting-row">
        <div class="row-info">
          <span class="row-label">一键反馈</span>
          <span class="row-sub">通过维护者的 GitHub 主页反馈 Bug 或建议</span>
        </div>
        <AppButton variant="primary" size="sm" icon="fas fa-comment-dots" @click="handleFeedback">
          GitHub 反馈
        </AppButton>
      </div>
      <div class="setting-row">
        <div class="row-info">
          <span class="row-label">项目主页</span>
          <span class="row-sub">维护者 GitHub 主页 · 项目与源码</span>
        </div>
        <AppIconButton icon="fas fa-arrow-up-right-from-square" size="sm" title="打开项目主页" @click="open(SUPPORT_GITHUB_URL)" />
      </div>
      <div class="setting-row">
        <div class="row-info">
          <span class="row-label">GitHub 反馈</span>
          <span class="row-sub">查看维护者项目，提出问题或功能建议</span>
        </div>
        <AppIconButton icon="fas fa-bug" size="sm" title="打开反馈页面" @click="open(SUPPORT_GITHUB_URL)" />
      </div>
      <div class="setting-row">
        <div class="row-info">
          <span class="row-label">联系维护者</span>
          <span class="row-sub">lcmovie · GitHub</span>
        </div>
        <AppIconButton icon="fas fa-user" size="sm" title="打开维护者主页" @click="open(SUPPORT_GITHUB_URL)" />
      </div>
      <div class="setting-row">
        <div class="row-info">
          <span class="row-label">部署支持</span>
          <span class="row-sub">通过 GitHub 联系，附上部署方式与报错信息</span>
        </div>
        <AppIconButton icon="fab fa-github" size="sm" title="打开支持主页" @click="open(SUPPORT_GITHUB_URL)" />
      </div>
      <div class="setting-row">
        <div class="row-info">
          <span class="row-label">GitHub 主页</span>
          <span class="row-sub">{{ SUPPORT_GITHUB_URL }}</span>
        </div>
        <AppIconButton icon="fab fa-github" size="sm" title="打开 GitHub 主页" @click="open(SUPPORT_GITHUB_URL)" />
      </div>
    </div>

    <!-- 原作者感谢与本版本改造说明 -->
    <div class="setting-group feedback-guide-group">
      <h4 class="group-title"><i class="fas fa-info-circle"></i> 对原作者的感谢及本项目修改信息</h4>
      <div class="guide-content">
        <p class="guide-item"><strong>感谢原作者：</strong>感谢 daimiaopeng 提供 coolapk-desktop 原项目。本版本基于原项目改造，保留 MIT 开源协议与原作者署名。</p>
        <p class="guide-item"><strong>原生网页呈现：</strong>将原桌面版内容以原生网页呈现，沿用原界面布局与尺寸，并支持不同分辨率下的内容居中显示。</p>
        <p class="guide-item"><strong>Docker 与持久化：</strong>支持 Docker / Compose 部署；账号 Cookie 与相关配置持久化保存在 Docker 安装目录，重启后可继续使用。</p>
      </div>
    </div>

    <p class="copyright">© 2026 daimiaopeng · MIT License</p>
  </div>
</template>

<script setup lang="ts">
import { APP_VERSION } from '../../constants/version';
import { APP_DISPLAY_NAME, SUPPORT_GITHUB_URL } from '../../constants/app';
import { CoolapkTauriAPI } from '../../api/coolapk';
import { useSettingsStore } from '../../stores/settings';
import AppButton from '../../components/common/AppButton.vue';
import AppIconButton from '../../components/common/AppIconButton.vue';
import { openFeedbackPage } from '../../utils/feedback';

const appVersion = APP_VERSION;
const settingsStore = useSettingsStore();

function handleFeedback() {
  void openFeedbackPage();
}

const channelLabel = settingsStore.settings.updateChannel === 'beta' ? '测试版渠道' : '稳定版';

const techStack = ['Vue 3', 'TypeScript', 'Pinia', 'Vite', 'Rust', 'Axum', 'Docker/Compose'];

function open(url: string) {
  void CoolapkTauriAPI.openUrl(url, 'system');
}

function checkUpdate() {
  window.dispatchEvent(new Event('check-for-update'));
}

</script>

<style scoped>
.settings-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  max-width: 720px;
}

.section-title {
  font-size: var(--font-size-title-md);
  font-weight: var(--font-weight-bold);
  color: var(--text-primary);
  border-bottom: 1px solid var(--border);
  padding-bottom: var(--space-3);
}

.setting-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.group-title {
  font-size: var(--font-size-title-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin-bottom: var(--space-1);
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border-light);
}

.row-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.row-label {
  font-size: var(--font-size-sub);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
}

.row-sub {
  font-size: var(--font-size-caption);
  color: var(--text-tertiary);
}

/* 应用信息头 */
.about-head {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) 0 var(--space-5);
  border-bottom: 1px solid var(--border-light);
}

.about-logo {
  width: 64px;
  height: 64px;
  border-radius: 18px;
  flex-shrink: 0;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
}

.about-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.about-name-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.about-name {
  font-size: var(--font-size-title-md);
  font-weight: var(--font-weight-bold);
  color: var(--text-primary);
}

.about-version {
  font-size: 12px;
  font-weight: 600;
  color: var(--brand-primary);
  background-color: var(--brand-soft);
  border: 1px solid var(--brand-green-border);
  padding: 1px 8px;
  border-radius: var(--radius-pill);
}

.about-channel {
  font-size: 11px;
  color: var(--text-tertiary);
  background-color: var(--background);
  border: 1px solid var(--border);
  padding: 1px 8px;
  border-radius: var(--radius-pill);
}

.about-desc {
  margin: 0;
  font-size: var(--font-size-caption);
  color: var(--text-tertiary);
  line-height: 1.6;
}

/* 技术栈与社区数据 */
.tech-row {
  align-items: flex-start;
  flex-wrap: wrap;
}

.tech-row .row-info {
  flex: 1 1 220px;
}

.tech-badges {
  flex: 1 1 260px;
  min-width: 0;
  display: flex;
  gap: var(--space-1);
  flex-wrap: wrap;
  justify-content: flex-end;
}

.tech-badge {
  font-size: 11px;
  background-color: var(--brand-soft);
  color: var(--brand-primary);
  border: 1px solid var(--brand-green-border);
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  font-weight: var(--font-weight-medium);
}

.repo-stats {
  display: flex;
  gap: var(--space-3);
}

.repo-stat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-sub);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.repo-stat i {
  font-size: 12px;
  color: var(--brand-primary);
}

.license-badge {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-secondary);
  background-color: var(--background);
  border: 1px solid var(--border);
  padding: 2px 12px;
  border-radius: var(--radius-pill);
}

.feedback-guide-group {
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.05) 0%, rgba(5, 150, 105, 0.02) 100%);
  border: 1px solid rgba(16, 185, 129, 0.15);
}

.feedback-guide-group .group-title {
  color: var(--brand-primary, #10b981);
  display: flex;
  align-items: center;
  gap: 6px;
}

.guide-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 0;
}

.guide-item {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.guide-item strong {
  color: var(--text-primary);
}

/* 链接行（与其他 setting-row 观感一致） */
.copyright {
  margin: 0;
  text-align: center;
  font-size: var(--font-size-caption);
  color: var(--text-tertiary);
  padding: var(--space-2) 0 var(--space-4);
}
</style>
