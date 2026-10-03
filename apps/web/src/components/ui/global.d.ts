export {};
declare module 'vue' {
  export interface GlobalComponents {
    AppButton: typeof import('@/components/ui/AppButton.vue')['default'];
    AppDialog: typeof import('@/components/ui/AppDialog.vue')['default'];
    AppIcon: typeof import('@/components/ui/AppIcon.vue')['default'];
    PageHeader: typeof import('@/components/ui/PageHeader.vue')['default'];
    EmptyState: typeof import('@/components/ui/EmptyState.vue')['default'];
    AppSkeleton: typeof import('@/components/ui/AppSkeleton.vue')['default'];
    AppPagination: typeof import('@/components/ui/AppPagination.vue')['default'];
    MarkdownContent: typeof import('@/components/ui/MarkdownContent.vue')['default'];
  }
}
