import { NoteScreen } from "@/features/notes/note-screen";

export default async function NotePage({ params }: { params: Promise<{ noteId: string }> }) {
  const { noteId } = await params;
  return <NoteScreen key={noteId} noteId={noteId} />;
}
