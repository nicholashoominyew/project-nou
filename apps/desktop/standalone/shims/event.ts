// The desktop app gets a background tick from its native side. In a page the interval and focus checks in the timetable code are enough.
export const listen = async (_name: string, _handler: () => void): Promise<() => void> => () => {};
