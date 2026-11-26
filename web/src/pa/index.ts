// What the rest of the app wires in (t-web): the Assistant view for the rail and the main switch, and the reminder bar,
// mounted once in App so due reminders show over every view.

export { AssistantView } from './Assistant.tsx';
export { ReminderBar, useDueReminders } from './reminders.tsx';
