// Core business logic for task reminders (used by controller and cron API).
const Task = require("../models/task");
const EmailTemplateModel = require("../models/emailTemplateModel");
const { sendMail } = require("./emailService");
const { renderTemplate } = require("../utils/templateRenderer");

async function runTaskReminders(pool) {
  const taskModel = new Task(pool);
  const emailTemplateModel = new EmailTemplateModel(pool);

  console.log(`[processReminders] Starting reminder check at ${new Date().toISOString()}`);
  const tasks = await taskModel.getTasksDueForReminder();
  console.log(`[processReminders] Found ${tasks.length} task(s) due for reminder`);

  if (tasks.length > 0) {
    console.log(`[processReminders] Task details:`, tasks.map(t => ({
      id: t.id,
      title: t.title,
      due_date: t.due_date,
      due_time: t.due_time,
      reminder_minutes_before_due: t.reminder_minutes_before_due,
      custom_fields_reminder: t.custom_fields?.Reminder || t.custom_fields?.['Reminder']
    })));
  }

  const results = { sent: 0, errors: [] };

  const template = await emailTemplateModel.getTemplateByType('TASK_REMINDER');
  console.log(`[processReminders] Email template ${template ? 'found' : 'not found, using default'}`);

  for (const task of tasks) {
    console.log(`[processReminders] Processing task ${task.id}: "${task.title}"`);

    const taskCheck = await taskModel.getById(task.id, null);
    if (taskCheck && taskCheck.reminder_sent_at) {
      console.log(`[processReminders] Task ${task.id} already has reminder_sent_at (${taskCheck.reminder_sent_at}), skipping`);
      continue;
    }

    console.log(`[processReminders] Task ${task.id} passed duplicate check, proceeding with email`);

    const emails = [];
    if (task.created_by_email) emails.push(task.created_by_email);
    if (task.assigned_to_email && task.assigned_to_email !== task.created_by_email) emails.push(task.assigned_to_email);
    if (emails.length === 0) {
      results.errors.push({ taskId: task.id, error: 'No email for owner or assigned to' });
      await taskModel.markReminderSent(task.id);
      continue;
    }

    const dueDate = task.due_date ? new Date(task.due_date).toLocaleDateString() : 'Not set';
    const dueTime = task.due_time || '';
    const dueStr = task.due_date && task.due_time
      ? `${dueDate} ${dueTime}`
      : task.due_date ? dueDate : 'Not set';

    const baseUrl = process.env.FRONTEND_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const taskLink = `${baseUrl}/dashboard/tasks/view?id=${task.id}`;
    const taskLinkHtml = `<a href="${taskLink}" style="display:inline-block;background-color:#4CAF50;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">View Task</a>`;

    const vars = {
      taskTitle: task.title || 'Task',
      taskDescription: task.description || '',
      dueDate: dueDate,
      dueTime: dueTime,
      dueDateAndTime: dueStr,
      assignedTo: task.assigned_to_name || 'Not assigned',
      createdBy: task.created_by_name || 'Unknown',
      organizationName: task.organization_name || '',
      hiringManagerName: task.hiring_manager_name || '',
      taskLink: taskLink,
    };

    const bodyVars = {
      ...vars,
      taskLink: taskLinkHtml,
    };

    const safeKeys = ['taskLink'];

    try {
      let subject, html, text;

      if (template) {
        subject = renderTemplate(template.subject, vars, safeKeys);
        html = renderTemplate(template.body, bodyVars, safeKeys);
        html = html.replace(/\r\n/g, "\n").replace(/\n/g, "<br/>");
        text = renderTemplate(template.body, vars, safeKeys);
      } else {
        subject = `Task reminder: ${task.title || 'Task'}`;
        html = `<p>This is a reminder for the following task:</p><p><strong>${task.title || 'Task'}</strong></p><p>Due: ${dueStr}</p><p>You are receiving this as the task owner or assignee.</p><p>${taskLinkHtml}</p>`;
        text = `Task reminder: ${task.title || 'Task'}. Due: ${dueStr}. View task: ${taskLink}`;
      }

      console.log(`[processReminders] Sending email to: ${emails.join(', ')}`);
      await sendMail({
        to: emails,
        subject,
        html,
        text,
      });

      await taskModel.markReminderSent(task.id);
      console.log(`[processReminders] Successfully sent reminder for task ${task.id} and marked as sent`);
      results.sent++;
    } catch (err) {
      console.error(`[processReminders] Error sending reminder for task ${task.id}:`, err);
      results.errors.push({ taskId: task.id, error: err.message });
    }
  }

  const response = {
    success: true,
    message: `Processed ${tasks.length} task(s), sent ${results.sent} reminder(s)`,
    ...results,
  };

  console.log(`[processReminders] Completed: ${response.message}`);
  if (results.errors.length > 0) {
    console.log(`[processReminders] Errors:`, results.errors);
  }

  return response;
}

module.exports = { runTaskReminders };
