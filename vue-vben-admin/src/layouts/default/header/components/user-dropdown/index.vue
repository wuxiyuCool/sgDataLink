<template>
  <Dropdown placement="bottomLeft" :overlayClassName="`${prefixCls}-dropdown-overlay`">
    <span :class="[prefixCls, `${prefixCls}--${theme}`]" class="flex">
      <img :class="`${prefixCls}__header`" :src="getUserInfo.avatar" />
      <span :class="`${prefixCls}__info hidden md:block`">
        <span :class="`${prefixCls}__name  `" class="truncate">
          {{ getUserInfo.realName }}
        </span>
      </span>
    </span>

    <template #overlay>
      <Menu @click="handleMenuClick">
        <MenuItem
          key="doc"
          :text="t('layout.header.dropdownItemDoc')"
          icon="ion:document-text-outline"
          v-if="getShowDoc"
        />
        <MenuDivider v-if="getShowDoc" />
        <MenuItem key="change-password" text="修改密码" icon="ion:key-outline" />
        <MenuItem
          key="logout"
          :text="t('layout.header.dropdownItemLoginOut')"
          icon="ion:power-outline"
        />
      </Menu>
    </template>
  </Dropdown>
  <ChangePasswordModal v-model:visible="pwdVisible" :forced="pwdForced" />
</template>
<script lang="ts">
  // components
  import { Dropdown, Menu } from 'ant-design-vue'
  import type { MenuInfo } from 'ant-design-vue/lib/menu/src/interface'

  import { defineComponent, computed, ref, watch } from 'vue'

  import { DOC_URL } from '/@/settings/siteSetting'

  import { useUserStore } from '/@/store/modules/user'
  import { useHeaderSetting } from '/@/hooks/setting/useHeaderSetting'
  import { useI18n } from '/@/hooks/web/useI18n'
  import { useDesign } from '/@/hooks/web/useDesign'
  import { useModal } from '/@/components/Modal'

  import headerImg from '/@/assets/images/header.jpg'
  import { propTypes } from '/@/utils/propTypes'
  import { openWindow } from '/@/utils'

  import { createAsyncComponent } from '/@/utils/factory/createAsyncComponent'
  import ChangePasswordModal from './ChangePasswordModal.vue'

  type MenuEvent = 'logout' | 'doc' | 'change-password'

  export default defineComponent({
    name: 'UserDropdown',
    components: {
      Dropdown,
      Menu,
      MenuItem: createAsyncComponent(() => import('./DropMenuItem.vue')),
      MenuDivider: Menu.Divider,
      ChangePasswordModal,
    },
    props: {
      theme: propTypes.oneOf(['dark', 'light']),
    },
    setup() {
      const { prefixCls } = useDesign('header-user-dropdown')
      const { t } = useI18n()
      const { getShowDoc } = useHeaderSetting()
      const userStore = useUserStore()

      const getUserInfo = computed(() => {
        const { realName = '', avatar, desc } = userStore.getUserInfo || {}
        return { realName, avatar: avatar || headerImg, desc }
      })

      const [register] = useModal()

      /** 契约 1.11：修改密码入口 + mustChangePassword 登录后强制弹窗（可延后，下次登录再提醒） */
      const pwdVisible = ref(false)
      const pwdForced = ref(false)
      const mustChange = computed(() => Boolean((userStore.getUserInfo as any)?.mustChangePassword))
      watch(
        mustChange,
        (must) => {
          if (must) {
            pwdForced.value = true
            pwdVisible.value = true
          }
        },
        { immediate: true },
      )

      //  login out
      function handleLoginOut() {
        userStore.confirmLoginOut()
      }

      // open doc
      function openDoc() {
        openWindow(DOC_URL)
      }

      function handleMenuClick(e: MenuInfo) {
        switch (e.key as MenuEvent) {
          case 'logout':
            handleLoginOut()
            break
          case 'doc':
            openDoc()
            break
          case 'change-password':
            pwdForced.value = false
            pwdVisible.value = true
            break
        }
      }

      return {
        prefixCls,
        t,
        getUserInfo,
        handleMenuClick,
        getShowDoc,
        register,
        pwdVisible,
        pwdForced,
      }
    },
  })
</script>
<style lang="less">
  @prefix-cls: ~'@{namespace}-header-user-dropdown';

  .@{prefix-cls} {
    height: @header-height;
    padding: 0 0 0 10px;
    padding-right: 10px;
    overflow: hidden;
    font-size: 12px;
    cursor: pointer;
    align-items: center;

    img {
      width: 24px;
      height: 24px;
      margin-right: 12px;
    }

    &__header {
      border-radius: 50%;
    }

    &__name {
      font-size: 14px;
    }

    &--dark {
      &:hover {
        background-color: @header-dark-bg-hover-color;
      }
    }

    &--light {
      &:hover {
        background-color: @header-light-bg-hover-color;
      }

      .@{prefix-cls}__name {
        color: @text-color-base;
      }

      .@{prefix-cls}__desc {
        color: @header-light-desc-color;
      }
    }

    &-dropdown-overlay {
      .ant-dropdown-menu-item {
        min-width: 160px;
      }
    }
  }
</style>
