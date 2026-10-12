import { defineConfig } from 'vitepress';

/**
 * 讲稿站点。源文件仍留在仓库原处，这里只负责把它们变成可翻页的阅读站。
 *
 * 总目录改写到站点首页。面试稿单独一页。设计文档各章保持原路径，
 * 这样文内的相对链接还能对上。
 */
const chapter = (file: string, text: string) => ({
  text,
  link: `/docs/react-design/${file}`,
});

const pages = process.env.GITHUB_PAGES === 'true';

export default defineConfig({
  title: 'mini-react 讲稿',
  description: '对着教学实现读 React 的更新链路',
  lang: 'zh-CN',
  base: pages ? '/mini-react-v3/' : '/',
  cleanUrls: true,
  lastUpdated: false,
  rewrites: {
    'React设计与实现.md': 'index.md',
    'INTERVIEW.md': 'interview.md',
  },
  srcExclude: [
    'AGENTS.md',
    '.cursor/**',
    'packages/**',
    'demos/**',
    'tests/**',
  ],
  markdown: {
    anchor: {
      slugify(source) {
        return source
          .trim()
          .toLowerCase()
          .replace(/[\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, '')
          .replace(/\s+/g, '-');
      },
    },
  },
  themeConfig: {
    siteTitle: 'mini-react',
    outline: { level: [2, 3], label: '本页目录' },
    sidebarMenuLabel: '全书目录',
    returnToTopLabel: '回到顶部',
    darkModeSwitchLabel: '外观',
    docFooter: { prev: '上一章', next: '下一章' },
    nav: [
      { text: '总目录', link: '/' },
      { text: '面试讲稿', link: '/interview' },
      {
        text: '源码',
        link: 'https://github.com/thosewhoyoulove/mini-react-v3',
      },
    ],
    search: {
      provider: 'local',
      options: {
        locales: {
          root: {
            translations: {
              button: { buttonText: '搜索', buttonAriaLabel: '搜索' },
              modal: {
                noResultsText: '没有找到相关段落',
                resetButtonTitle: '清除',
                footer: { selectText: '打开', navigateText: '切换', closeText: '关闭' },
              },
            },
          },
        },
      },
    },
    sidebar: [
      {
        text: '设计与实现',
        items: [
          { text: '总目录', link: '/' },
          chapter('01-声明式UI与命令式DOM的权衡', '1. 声明式 UI'),
          chapter('02-教学版框架要具备的核心能力', '2. 教学版要具备的能力'),
          chapter('03-mini-react包结构与依赖方向', '3. 包结构'),
          chapter('04-ReactElement与createElement', '4. ReactElement'),
          chapter('05-JSX与jsx-runtime与typeof', '5. JSX'),
          chapter('06-Fiber链表与双缓冲', '6. Fiber 与双缓冲'),
          chapter('07-副作用标记Flags', '7. Flags'),
          chapter('08-工作循环', '8. 工作循环'),
          chapter('09-beginWork按tag分发', '9. beginWork'),
          chapter('10-子节点Diff', '10. Diff'),
          chapter('11-completeWork', '11. completeWork'),
          chapter('12-Commit三阶段', '12. Commit'),
          chapter('13-函数组件的执行时机', '13. 函数组件'),
          chapter('14-Hook链表与Dispatcher', '14. Hook 链表'),
          chapter('15-useState与更新队列', '15. useState'),
          chapter('16-useEffect与useLayoutEffect', '16. 两种 Effect'),
          chapter('17-Scheduler与时间切片', '17. Scheduler'),
          chapter('18-最小Lane', '18. Lane'),
          chapter('19-HostConfig抽象', '19. HostConfig'),
          chapter('20-DOM属性与简易事件', '20. DOM 与事件'),
          chapter('21-createRoot与updateContainer', '21. createRoot'),
          chapter('appendix', '附录'),
          { text: '面试讲稿', link: '/interview' },
          { text: '仓库说明', link: '/README' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/thosewhoyoulove/mini-react-v3' },
    ],
  },
  vite: {
    server: {
      host: true,
      port: 5199,
    },
  },
});
