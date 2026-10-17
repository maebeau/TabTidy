# TabTidy

找出重复网址和相似标题，按自然顺序或打开时间排列，输出供人工确认的预选结果。

当前是独立 JavaScript core，使用 Node.js 22+，无第三方依赖。接收 JSON 清单，不访问浏览器、不关闭标签页。

## 运行

无需安装依赖，在项目目录运行：

```sh
npm test
npm run demo
node cli.js examples/tabs.json time desc
node cli.js examples/tabs.json natural asc
```

将示例文件路径替换为自己的 JSON 清单即可。输出写到终端，可重定向保存；读取或校验失败时返回非零状态，错误写入 stderr。

## 使用 core

```js
import { analyzeTabs } from './src/core.js';

const groups = analyzeTabs([
  { id: 'old', title: '某某书 第9章 出发', openedAt: 1000 },
  { id: 'new', title: '某某书 第10章 重逢', openedAt: 2000 },
], { sortBy: 'natural', direction: 'desc' });
```

结果：

```json
[
  {
    "reasons": ["similar-title"],
    "tabs": [
      { "id": "new", "title": "某某书 第10章 重逢", "openedAt": 2000, "selected": false },
      { "id": "old", "title": "某某书 第9章 出发", "openedAt": 1000, "selected": true }
    ]
  }
]
```

输入字段：

| 字段 | 约定 |
| --- | --- |
| `id` | 必填且唯一，非空字符串或非负安全整数；数字 `1` 和字符串 `"1"` 是不同 ID |
| `title` | 必填字符串；空标题不参与标题匹配，仍可按网址归组 |
| `url` | 可选的绝对网址字符串；空字符串、null 或省略表示未知 |
| `openedAt` | 可选的非负安全整数，单位为毫秒；null 或省略表示未知 |

选项只有 `sortBy`（`natural` / `time`）与 `direction`（`asc` / `desc`），默认为自然降序。core 不修改输入，每个输出标签页都是浅拷贝；已有的 `selected` 会被本次预选结果覆盖。

## 分组与预选规则

- 完整网址相同：原因 `duplicate-url`；查询参数、片段等差异会保留。
- 标题统一全半角、大小写、空白和标点。数字后缀变化可归组，例如 `xxx1` / `xxx1-2`、`某某书 1–20` / `某某书 1–30`。
- 标题包含“书名 第N章/节/回/卷/集/部”时，用前面的书名匹配，因此章节号与后续章节名可以不同；这里的 N 可以是阿拉伯数字或常见中文数字。
- 其他较长标题使用字符对集合的 Dice 相似度：归一化后的标题都至少 6 个字符，且得分至少 0.85，才列为候选。
- 不区分网站。候选关系可传递，例如 A 与 B 标题相似、B 与 C 网址重复，则三者归为一组；一组内任意两项不一定直接相似。
- 只输出至少两个标签页的候选组；组间保持各组首次出现在输入中的顺序，排序作用于组内。
- 自然排序用标题中的连续阿拉伯数字比较数值，例如 `第2章 → 第10章`；不推断章节进度或解析中文数字的大小。
- 一般保留组内排序后的第一项（`selected: false`），预选其余项（`selected: true`）。升序会优先保留较小/较旧的项，降序优先保留较大/较新的项。
- 时间排序时未知时间始终在末尾，并列保持输入顺序；组内有未知或并列时间时，整组全部 `selected: false`，交给人工选择。

打开时间必须来自可靠的数据源，不能拿浏览器恢复时刻或最后访问时间冒充。core 不负责采集、补推或持久化时间。

标题匹配只是检查线索：站点后缀、标题格式及相似书名都可能造成误分组或漏分组。第一版使用两两比较，适用于个人标签页清单；没有面向超大数据集优化。

## 本地任务记录

本次范围见 `.scratch/core/spec.md`，任务见 `.scratch/core/issues/01-core.md`。代理配置入口为 `AGENTS.md`，术语见 `GLOSSARY.md`。
