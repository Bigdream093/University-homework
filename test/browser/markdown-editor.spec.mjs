import { test, expect } from "@playwright/test";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWMQDfWDIwacHAClqwihzfiS1QAAAABJRU5ErkJggg==",
  "base64",
);
async function actor(request, username = "teacher") {
  const result = await request.post("/api/auth/login", {
    data: { username, password: "123456" },
  });
  expect(result.ok()).toBeTruthy();
  return result.json();
}
async function session(page, user, url) {
  await page.goto("/login");
  await page.evaluate((user) => {
    localStorage.setItem("hw_token", user.token);
    localStorage.setItem(
      "hw_user",
      JSON.stringify({ ...user.user, must_change_password: 0 }),
    );
  }, user);
  await page.goto(url);
}

test("Markdown assignment: file picker, screenshot paste, drop, preview, fullscreen and saved images", async ({
  page,
  request,
}, testInfo) => {
  const teacher = await actor(request);
  const headers = { Authorization: `Bearer ${teacher.token}` };
  const course = await (
    await request.post("/api/courses", {
      headers,
      data: { name: "图文编辑验收" },
    })
  ).json();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await session(page, teacher, `/teacher/courses/${course.id}`);
  await page.getByRole("button", { name: "发布新作业", exact: true }).click();
  const form = page.getByRole("dialog", { name: "创建作业", exact: true });
  await form.getByLabel("作业标题", { exact: true }).fill("截图与表格作业");
  const editor = form.getByRole("textbox", {
    name: "作业要求 Markdown",
    exact: true,
  });
  await editor.fill(
    "## 作业目标\n\n| 提交内容 | 要求 |\n| --- | --- |\n| 分析图 | 三张 |\n\n",
  );
  await expect(form.locator(".preview table")).toBeVisible();
  await form
    .locator("input[type=file]")
    .setInputFiles({ name: "选择.png", mimeType: "image/png", buffer: png });
  await expect(
    form.getByRole("button", { name: "保存", exact: true }),
  ).toBeEnabled();
  await expect(form.locator(".preview img")).toHaveCount(1);
  for (const eventType of ["paste", "drop"]) {
    await editor.evaluate(
      (element, { eventType, bytes }) => {
        const transfer = new DataTransfer();
        transfer.items.add(
          new File([new Uint8Array(bytes)], eventType + ".png", {
            type: "image/png",
          }),
        );
        const event =
          eventType === "paste"
            ? new ClipboardEvent("paste", {
                clipboardData: transfer,
                bubbles: true,
                cancelable: true,
              })
            : new DragEvent("drop", {
                dataTransfer: transfer,
                bubbles: true,
                cancelable: true,
              });
        element.dispatchEvent(event);
      },
      { eventType, bytes: [...png] },
    );
    await expect(
      form.getByRole("button", { name: "保存", exact: true }),
    ).toBeEnabled();
    await expect(form.locator(".preview img")).toHaveCount(
      eventType === "paste" ? 2 : 3,
    );
  }
  await expect
    .poll(() =>
      form
        .locator(".preview img")
        .evaluateAll((images) =>
          images.every((img) => img.complete && img.naturalWidth > 0),
        ),
    )
    .toBe(true);
  await form.getByRole("button", { name: "全屏编辑", exact: true }).click();
  await expect(form.locator(".markdown-editor")).toHaveClass(/fullscreen/);
  await form.getByRole("button", { name: "退出全屏", exact: true }).click();
  await page.screenshot({
    path: testInfo.outputPath("markdown-assignment.png"),
    fullPage: true,
  });
  await form.getByRole("button", { name: "保存", exact: true }).click();
  await expect(form).not.toBeVisible();
  const assignments = await (
    await request.get(`/api/courses/${course.id}/assignments`, { headers })
  ).json();
  expect(assignments[0].description_format).toBe("markdown");
  expect(assignments[0].description.match(/!\[图片说明\]/g)).toHaveLength(3);
  await page
    .getByRole("heading", { name: "截图与表格作业", exact: true })
    .click();
  await expect(
    page.locator(".card-body .markdown-content table"),
  ).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".card-body .markdown-content img")
        .evaluateAll(
          (images) =>
            images.length === 3 && images.every((img) => img.naturalWidth > 0),
        ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "编辑作业", exact: true });
  await expect(
    edit.getByRole("textbox", { name: "作业要求 Markdown", exact: true }),
  ).toHaveValue(assignments[0].description);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      edit
        .locator(".editor-body")
        .evaluate(
          (element) =>
            getComputedStyle(element).gridTemplateColumns.split(" ").length,
        ),
    )
    .toBe(1);
  await page.screenshot({
    path: testInfo.outputPath("markdown-mobile.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("Notice and student Q&A use the shared editor and retain screenshots after saving", async ({
  page,
  request,
}) => {
  const teacher = await actor(request);
  const headers = { Authorization: `Bearer ${teacher.token}` };
  const course = await (
    await request.post("/api/courses", {
      headers,
      data: { name: "通知问答图文验收" },
    })
  ).json();
  const studentName = "20269888";
  await request.post(`/api/courses/${course.id}/students`, {
    headers,
    data: { username: studentName, name: "截图同学" },
  });
  await session(page, teacher, `/teacher/courses/${course.id}`);
  await page.getByRole("tab", { name: /^通知/ }).click();
  await page.getByRole("button", { name: "发布通知", exact: true }).click();
  const notice = page.getByRole("dialog", { name: "发布通知", exact: true });
  await notice.getByLabel("标题", { exact: true }).fill("图文通知");
  await notice
    .getByRole("textbox", { name: "通知内容 Markdown", exact: true })
    .fill("## 通知正文");
  await notice
    .locator("input[type=file]")
    .setInputFiles({ name: "通知.png", mimeType: "image/png", buffer: png });
  await expect(notice.locator(".preview img")).toHaveCount(1);
  await notice.getByText("立即发布", { exact: true }).click();
  await notice.getByRole("button", { name: "保存", exact: true }).click();
  await expect(notice).not.toBeVisible();
  const student = await actor(request, studentName);
  await session(page, student, `/student/courses/${course.id}`);
  await page.getByRole("tab", { name: /^通知/ }).click();
  await page.getByRole("heading", { name: "图文通知", exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator(".markdown-content img")
        .evaluateAll(
          (images) =>
            images.length > 0 && images.every((img) => img.naturalWidth > 0),
        ),
    )
    .toBe(true);
  await page.getByRole("tab", { name: "课程问答", exact: true }).click();
  await page.getByRole("button", { name: "提问", exact: true }).click();
  const question = page.getByRole("dialog", { name: "提出问题", exact: true });
  await question.getByPlaceholder("标题", { exact: true }).fill("请看截图");
  await question
    .getByRole("textbox", { name: "问题内容 Markdown", exact: true })
    .fill("## 这个步骤如何处理？");
  await question
    .locator("input[type=file]")
    .setInputFiles({ name: "疑问.png", mimeType: "image/png", buffer: png });
  await expect(question.locator(".preview img")).toHaveCount(1);
  await question.getByRole("button", { name: "保存", exact: true }).click();
  await expect(question).not.toBeVisible();
  await page.getByRole("button", { name: "请看截图", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "请看截图", exact: true });
  await expect
    .poll(() =>
      detail
        .locator(".markdown-content img")
        .evaluateAll(
          (images) =>
            images.length > 0 && images.every((img) => img.naturalWidth > 0),
        ),
    )
    .toBe(true);
  await detail
    .getByRole("textbox", { name: "私人回复 Markdown", exact: true })
    .fill("**补充说明**");
  await detail
    .getByRole("button", { name: "发送私人回复", exact: true })
    .click();
  await expect(
    detail.locator("strong").filter({ hasText: "补充说明" }),
  ).toBeVisible();
});
