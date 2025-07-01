#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ArXivClient } from '@agentic/arxiv';
import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import { PdfReader } from "pdfreader";
import { tmpdir } from "os";
import { JSDOM } from "jsdom";

// 初始化 ArXiv 客户端
const arxivClient = new ArXivClient({});

// 创建 MCP 服务器
const server = new Server(
  {
    name: "arxiv-paper-mcp",
    version: "1.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 工具函数：搜索 arXiv 论文
async function searchArxivPapers(query: string, maxResults: number = 5): Promise<{totalResults: number, papers: any[]}> {
  try {
    const results = await arxivClient.search({
      start: 0,
      searchQuery: {
        include: [
          { field: "all", value: query }
        ]
      },
      maxResults: maxResults
    });

    const papers = results.entries.map(entry => {
      const urlParts = entry.url.split('/');
      const arxivId = urlParts[urlParts.length - 1];

      return {
        id: arxivId,
        url: entry.url,
        title: entry.title.replace(/\s+/g, ' ').trim(),
        summary: entry.summary.replace(/\s+/g, ' ').trim(),
        published: entry.published,
        authors: entry.authors || []
      };
    });

    return {
      totalResults: results.totalResults,
      papers: papers
    };
  } catch (error) {
    console.error("搜索 arXiv 论文时出错:", error);
    throw new Error(`搜索失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// 工具函数：检查是否有 HTML 版本并获取内容
async function getArxivHtmlContent(arxivId: string): Promise<string | null> {
  try {
    const cleanArxivId = arxivId.replace(/v\d+$/, '');
    const htmlUrl = `https://arxiv.org/html/${cleanArxivId}`;
    
    console.log(`尝试获取 HTML 版本: ${htmlUrl}`);
    
    const response = await axios({
      method: 'GET',
      url: htmlUrl,
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ArXiv-Paper-MCP/1.0)'
      }
    });

    // 检查响应状态和内容类型
    if (response.status === 200 && response.headers['content-type']?.includes('text/html')) {
      const html = response.data;
      
      // 简单检查是否是有效的论文HTML（而不是错误页面）
      if (html.includes('ltx_document') || html.includes('ltx_page_main') || html.includes('ltx_abstract')) {
        console.log(`成功获取 HTML 版本: ${htmlUrl}`);
        return html;
      }
    }
    
    console.log(`HTML 版本不可用或无效: ${htmlUrl}`);
    return null;
  } catch (error) {
    console.log(`HTML 版本获取失败，将使用 PDF: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// 工具函数：从 HTML 中提取文本内容
function extractTextFromHtml(html: string): string {
  try {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    
    // 移除脚本和样式标签
    const scripts = document.querySelectorAll('script, style');
    scripts.forEach(el => el.remove());
    
    // 获取主要内容区域
    let mainContent = document.querySelector('.ltx_page_main') || 
                     document.querySelector('.ltx_document') || 
                     document.querySelector('body');
    
    if (!mainContent) {
      throw new Error('无法找到主要内容区域');
    }
    
    // 提取文本内容
    let text = mainContent.textContent || '';
    
    // 清理文本：移除多余的空白字符
    text = text.replace(/\s+/g, ' ').trim();
    
    if (text.length < 100) {
      throw new Error('HTML 文本内容过少');
    }
    
    return text;
  } catch (error) {
    console.error("HTML 文本提取失败:", error);
    throw new Error(`HTML 解析失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}
// 工具函数：获取 AI 领域最新论文
async function getRecentAIPapers(): Promise<string> {
  try {
    const url = 'https://arxiv.org/list/cs.AI/recent';
    console.log(`正在获取 AI 领域最新论文: ${url}`);

    const response = await axios({
      method: 'GET',
      url: url,
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ArXiv-Paper-MCP/1.0)'
      }
    });

    return response.data;
  } catch (error) {
    console.error("获取最新 AI 论文时出错:", error);
    throw new Error(`获取最新论文失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}
// 工具函数：获取 arXiv PDF 下载链接
function getArxivPdfUrl(input: string): string {
  try {
    let arxivId: string;
    let pdfUrl: string;

    if (input.startsWith('http://') || input.startsWith('https://')) {
      const urlParts = input.split('/');
      arxivId = urlParts[urlParts.length - 1];
      pdfUrl = input.replace('/abs/', '/pdf/') + '.pdf';
    } else {
      arxivId = input;
      pdfUrl = `http://arxiv.org/pdf/${arxivId}.pdf`;
    }

    return pdfUrl;
  } catch (error) {
    console.error("获取 PDF 链接时出错:", error);
    throw new Error(`获取PDF链接失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// 工具函数：下载临时 PDF 文件
async function downloadTempPdf(pdfUrl: string): Promise<string> {
  try {
    console.log(`正在下载临时 PDF: ${pdfUrl}`);

    const response = await axios({
      method: 'GET',
      url: pdfUrl,
      responseType: 'stream',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ArXiv-Paper-MCP/1.0)'
      }
    });

    // 创建临时文件路径
    const tempPath = path.join(tmpdir(), `arxiv_temp_${Date.now()}.pdf`);
    const writer = fs.createWriteStream(tempPath);
    response.data.pipe(writer);

    return new Promise<string>((resolve, reject) => {
      writer.on('finish', () => {
        console.log(`临时 PDF 下载完成: ${tempPath}`);
        resolve(tempPath);
      });
      writer.on('error', (error) => {
        console.error(`临时 PDF 下载失败: ${error}`);
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
        reject(error);
      });
    });
  } catch (error) {
    console.error("下载临时 PDF 时出错:", error);
    throw new Error(`下载失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// 工具函数：提取 PDF 文本内容
async function extractPdfText(pdfPath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const texts: string[] = [];
    new PdfReader().parseFileItems(pdfPath, (err, item) => {
      if (err) {
        console.error("PDF 解析失败:", err);
        reject(new Error("PDF 解析失败: " + err));
      } else if (!item) {
        // 解析结束，拼成一段文本
        let text = texts.join(' ').replace(/\s+/g, ' ').trim();
        if (text.length < 100) {
          reject(new Error("PDF 文本提取失败或内容过少"));
        } else {
          resolve(text);
        }
      } else if (item.text) {
        texts.push(item.text);
      }
    });
  });
}

// 工具函数：解析论文内容（优先 HTML，回退 PDF）
async function parsePaperContent(input: string, paperInfo?: any): Promise<{content: string, source: 'html' | 'pdf'}> {
  let tempPdfPath: string | null = null;
  
  try {
    // 获取 arXiv ID
    let arxivId: string;
    if (input.startsWith('http://') || input.startsWith('https://')) {
      const urlParts = input.split('/');
      arxivId = urlParts[urlParts.length - 1];
    } else {
      arxivId = input;
    }
    
    // 首先尝试获取 HTML 版本
    console.log("尝试获取 HTML 版本...");
    const htmlContent = await getArxivHtmlContent(arxivId);
    
    let paperText: string;
    let source: 'html' | 'pdf';
    
    if (htmlContent) {
      // 使用 HTML 版本
      console.log("使用 HTML 版本解析内容");
      paperText = extractTextFromHtml(htmlContent);
      source = 'html';
    } else {
      // 回退到 PDF 版本
      console.log("HTML 版本不可用，回退到 PDF 版本");
      const pdfUrl = getArxivPdfUrl(input);
      tempPdfPath = await downloadTempPdf(pdfUrl);
      paperText = await extractPdfText(tempPdfPath);
      source = 'pdf';
    }
    
    // 构建输出内容
    let outputContent = '';

    if (paperInfo) {
      outputContent += `=== 论文信息 ===\n`;
      outputContent += `标题: ${paperInfo.title}\n`;
      outputContent += `arXiv ID: ${arxivId}\n`;
      outputContent += `发布日期: ${paperInfo.published}\n`;
      outputContent += `内容来源: ${source.toUpperCase()}\n`;

      if (paperInfo.authors && paperInfo.authors.length > 0) {
        outputContent += `作者: ${paperInfo.authors.map((author: any) => author.name || author).join(', ')}\n`;
      }

      outputContent += `摘要: ${paperInfo.summary}\n`;
      outputContent += `\n=== 论文内容 ===\n\n`;
    } else {
      outputContent += `=== 论文内容 (来源: ${source.toUpperCase()}) ===\n\n`;
    }

    outputContent += paperText;

    return { content: outputContent, source };
  } catch (error) {
    console.error("解析论文内容时出错:", error);
    throw new Error(`论文内容解析失败: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    // 清理临时 PDF 文件
    if (tempPdfPath && fs.existsSync(tempPdfPath)) {
      try {
        fs.unlinkSync(tempPdfPath);
        console.log(`临时文件已删除: ${tempPdfPath}`);
      } catch (cleanupError) {
        console.warn(`清理临时文件失败: ${cleanupError}`);
      }
    }
  }
}

// 注册工具列表处理器
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search_arxiv",
        description: "搜索 arXiv 论文",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "搜索关键词"
            },
            maxResults: {
              type: "number",
              description: "最大结果数量",
              default: 5
            }
          },
          required: ["query"]
        }
      },
      {
        name: "get_recent_ai_papers",
        description: "获取 arXiv AI 领域最新论文（cs.AI/recent）",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        }
      },
      {
        name: "get_arxiv_pdf_url",
        description: "获取 arXiv PDF 下载链接",
        inputSchema: {
          type: "object",
          properties: {
            input: {
              type: "string",
              description: "arXiv 论文URL（如：http://arxiv.org/abs/2403.15137v1）或 arXiv ID（如：2403.15137v1）"
            }
          },
          required: ["input"]
        }
      },
      {
        name: "parse_paper_content",
        description: "解析论文内容（优先使用 HTML 版本，回退到 PDF）",
        inputSchema: {
          type: "object",
          properties: {
            input: {
              type: "string",
              description: "arXiv 论文URL或 arXiv ID"
            },
            paperInfo: {
              type: "object",
              description: "论文信息（可选，用于添加论文元数据）",
              properties: {
                title: { type: "string" },
                summary: { type: "string" },
                published: { type: "string" },
                authors: { type: "array" }
              }
            }
          },
          required: ["input"]
        }
      }
    ]
  };
});

// 注册工具调用处理器
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "search_arxiv": {
        const { query, maxResults = 5 } = args as { query: string; maxResults?: number };
        const results = await searchArxivPapers(query, maxResults);

        return {
          content: [{
            type: "text",
            text: `找到 ${results.papers.length} 篇相关论文（总计 ${results.totalResults} 篇）：\n\n${results.papers.map((paper, index) =>
              `${index + 1}. **${paper.title}**\n   ID: ${paper.id}\n   发布日期: ${paper.published}\n   作者: ${paper.authors.map((author: any) => author.name || author).join(', ')}\n   摘要: ${paper.summary.substring(0, 300)}...\n   URL: ${paper.url}\n`
            ).join('\n')}`
          }]
        };
      }

      case "get_recent_ai_papers": {
        const htmlContent = await getRecentAIPapers();

        return {
          content: [{
            type: "text",
            text: htmlContent
          }]
        };
      }

      case "get_arxiv_pdf_url": {
        const { input } = args as { input: string };
        const pdfUrl = getArxivPdfUrl(input);

        return {
          content: [{
            type: "text",
            text: `PDF 下载链接: ${pdfUrl}`
          }]
        };
      }

      case "parse_paper_content": {
        const { input, paperInfo } = args as { input: string; paperInfo?: any };
        const result = await parsePaperContent(input, paperInfo);

        return {
          content: [{
            type: "text",
            text: result.content
          }]
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `工具执行失败: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
});

// 启动服务器
console.log("启动 ArXiv Paper MCP Server...");

const transport = new StdioServerTransport();
await server.connect(transport);

console.log("🚀 ArXiv Paper MCP Server 已启动，等待连接...");