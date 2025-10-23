require('dotenv').config();
const express = require('express');
const { Octokit } = require('@octokit/rest');

const app = express();
app.use(express.json({ limit: '50mb' }));

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const MIT_LICENSE = `MIT License

Copyright (c) 2025

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

async function generateCode(brief, checks, attachments) {
  const attachmentText = attachments.map(a => 
    `Attachment: ${a.name} - ${a.url.substring(0, 100)}...`
  ).join('\n');

  const prompt = `Create a complete, self-contained HTML file that does this:

${brief}

Requirements:
${checks.map(c => `- ${c}`).join('\n')}

${attachments.length > 0 ? `\nAttachments provided:\n${attachmentText}` : ''}

Return ONLY valid HTML code with inline CSS and JavaScript. Make it functional and complete.`;

try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4000
      })
    });

    const data = await response.json();
    
    console.log('API Response Status:', response.status);
    console.log('API Response:', JSON.stringify(data, null, 2));
    
    if (data.error) {
      throw new Error(`Groq API Error: ${data.error.message}`);
    }
    
    if (!data.choices || !data.choices[0]) {
      throw new Error(`Unexpected API response format: ${JSON.stringify(data)}`);
    }
    
    return data.choices[0].message.content;
  } catch (error) {
    console.error('Full error in generateCode:', error);
    throw error;
  }
}

async function createGitHubRepo(repoName, code, brief, checks) {
  const repo = await octokit.repos.createForAuthenticatedUser({
    name: repoName,
    description: brief.substring(0, 100),
    auto_init: false,
    private: false
  });

  const owner = process.env.GITHUB_USERNAME;

  await new Promise(resolve => setTimeout(resolve, 2000));

  const readme = `# ${repoName}

## Summary
${brief}

## Setup
1. Clone this repository
2. Open index.html in a browser

## Usage
Visit the GitHub Pages URL or open index.html locally.

## Code Explanation
This application is built as a single HTML file with embedded CSS and JavaScript to meet the following requirements:
${checks.map(c => `- ${c}`).join('\n')}

## License
MIT License`;

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo: repoName,
    path: 'README.md',
    message: 'Add README',
    content: Buffer.from(readme).toString('base64')
  });

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo: repoName,
    path: 'LICENSE',
    message: 'Add MIT license',
    content: Buffer.from(MIT_LICENSE).toString('base64')
  });

  const fileResponse = await octokit.repos.createOrUpdateFileContents({
    owner,
    repo: repoName,
    path: 'index.html',
    message: 'Add application code',
    content: Buffer.from(code).toString('base64')
  });

  try {
    await octokit.repos.createPagesSite({
      owner,
      repo: repoName,
      source: { branch: 'main', path: '/' }
    });
  } catch (error) {
    console.log('Pages setup may need manual enabling:', error.message);
  }

  return {
    repo_url: repo.data.html_url,
    commit_sha: fileResponse.data.commit.sha,
    pages_url: `https://${owner}.github.io/${repoName}/`
  };
}

async function notifyEvaluator(evaluationUrl, payload, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(evaluationUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        console.log('✅ Evaluator notified successfully');
        return;
      }
    } catch (error) {
      console.log(`Attempt ${i + 1} failed:`, error.message);
    }

    const delay = Math.pow(2, i) * 1000;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  console.error('❌ Failed to notify evaluator after all retries');
}

app.post('/build', async (req, res) => {
  console.log('📬 Received request');

  if (req.body.secret !== process.env.MY_SECRET) {
    return res.status(403).json({ error: 'Invalid secret' });
  }

  res.status(200).json({ message: 'Request accepted, processing...' });

  try {
    const { email, task, round, nonce, brief, checks, evaluation_url, attachments = [] } = req.body;

    console.log(`Building app for task: ${task}, round: ${round}`);

    const code = await generateCode(brief, checks, attachments);

    const uniqueId = nonce || Date.now();
    const repoName = `${task}-r${round}-${uniqueId}`;
    const repoInfo = await createGitHubRepo(repoName, code, brief, checks);

    console.log('✅ Repository created:', repoInfo.repo_url);

    await notifyEvaluator(evaluation_url, {
      email,
      task,
      round,
      nonce,
      ...repoInfo
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});