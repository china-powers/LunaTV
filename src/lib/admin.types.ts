export interface AdminConfig {
  ConfigSubscribtion: {
    URL: string;
    AutoUpdate: boolean;
    LastCheck: string;
  };
  ConfigFile: string;
  SiteConfig: {
    SiteName: string;
    Announcement: string;
    SearchDownstreamMaxPage: number;
    SiteInterfaceCacheTime: number;
    DoubanProxyType: string;
    DoubanProxy: string;
    DoubanImageProxyType: string;
    DoubanImageProxy: string;
    DisableYellowFilter: boolean;
    FluidSearch: boolean;
    EnableWebLive: boolean;
  };
  UserConfig: {
    Users: {
      username: string;
      role: 'user' | 'admin' | 'owner';
      banned?: boolean;
      enabledApis?: string[]; // 优先级高于tags限制
      tags?: string[]; // 多 tags 取并集限制
    }[];
    Tags?: {
      name: string;
      enabledApis: string[];
    }[];
  };
  SourceConfig: {
    key: string;
    name: string;
    api: string;
    detail?: string;
    from: 'config' | 'custom';
    disabled?: boolean;
    // 以下是定时健康检查维护的状态
    disabledBy?: 'auto' | 'manual'; // 停用来源：自动检测 / 人工操作
    failCount?: number; // 连续检测失败次数
    successCount?: number; // 自动停用后连续检测成功的次数
    lastCheckAt?: string; // 最近一次检测时间（ISO）
    lastCheckError?: string; // 最近一次检测失败原因
  }[];
  CustomCategories: {
    name?: string;
    type: 'movie' | 'tv';
    query: string;
    from: 'config' | 'custom';
    disabled?: boolean;
  }[];
  LiveConfig?: {
    key: string;
    name: string;
    url: string; // m3u 地址
    ua?: string;
    epg?: string; // 节目单
    from: 'config' | 'custom';
    channelNumber?: number;
    disabled?: boolean;
    // 以下是定时健康检查维护的状态
    disabledBy?: 'auto' | 'manual'; // 停用来源：自动检测 / 人工操作
    failCount?: number; // 连续检测失败次数
    successCount?: number; // 自动停用后连续检测成功的次数
    lastCheckAt?: string; // 最近一次检测时间（ISO）
    lastCheckError?: string; // 最近一次检测失败原因
  }[];
}

export interface AdminConfigResult {
  Role: 'owner' | 'admin';
  Config: AdminConfig;
}
